// The exports port's progress reports (PRO-096 criterion 2; PRO-086 criterion 2): with onProgress,
// the port reports the job now and at each change of its state, by reading the job every
// EXPORT_POLL_MS, until a terminal state, a not_found answer, or close(). The job is moved on by the
// test through FileServer, which answers the export routes. Universal: Node.js and browsers.
// Lane U-PRO-086-102: the decisions are in docs/adr/0314-lane-U-PRO-086-102.md.
import { describe, expect, it, vi } from 'vitest';
import type { ExportJob, SyncChannel } from '@docedit/protocol';
import { createDepBackend, type DepBackend } from './index.ts';
import { LEGAL_GRANT, USERS, contractDocument } from '../test/support/fixtures.ts';
import { MemoryNetwork } from '../test/support/memory-network.ts';
import { MockDepServer } from '../test/support/mock-server.ts';
import { FileServer } from '../test/support/file-server.ts';
import { EXPORT_POLL_MS } from './files.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Setup {
  dep: MockDepServer;
  files: FileServer;
  docId: string;
  make(): DepBackend;
}

function setup(): Setup {
  const dep = new MockDepServer({
    welcome: (d) => ({
      ...d,
      features: [
        ...new Set([...((d['features'] as string[] | undefined) ?? []), 'assets', 'exports']),
      ],
    }),
  });
  const files = new FileServer(dep);
  const net = new MemoryNetwork(files);
  const docId = dep.service.createDocument(contractDocument(), { grants: [LEGAL_GRANT] });
  return {
    dep,
    files,
    docId,
    make: () =>
      createDepBackend({
        endpoint: dep.endpoint,
        getToken: async () => dep.mintToken(USERS.editor, { [docId]: 'editor' }),
        features: ['presence', 'regions', 'suggest-enforced', 'assets', 'exports'],
        platform: { random: () => 0, ...net.platform() },
      }),
  };
}

/** Connects and opens a channel, as the other tests of the ports do; the REST client needs discovery. */
async function connected(s: Setup, b: DepBackend): Promise<SyncChannel> {
  await b.connect();
  const c = await b.sync.loadContent(s.docId);
  return b.sync.open(s.docId, { resume: { seq: c.seq, incarnation: c.incarnation } });
}

/** The export reads the server answered so far. */
const reads = (s: Setup): number =>
  s.files.answered.filter((a) => a.method === 'GET' && a.path.includes('/exports/')).length;

describe('the export progress reports (PRO-096, PRO-086)', () => {
  it('reports the job at once, then each change of state, until completed; then it stops reading', async () => {
    const s = setup();
    const b = s.make();
    await connected(s, b);
    const seen: string[] = [];
    const job = await b.exports!.request(
      s.docId,
      { target: 'pdf' },
      { onProgress: (j: ExportJob) => seen.push(j.state) },
    );
    expect(seen).toEqual(['queued']);
    const stored = s.files.jobs.get(job.id)!;
    await sleep(EXPORT_POLL_MS + 200);
    stored.state = 'compiling';
    await vi.waitFor(() => expect(seen).toEqual(['queued', 'compiling']), { timeout: 5000 });
    stored.state = 'completed';
    await vi.waitFor(() => expect(seen).toEqual(['queued', 'compiling', 'completed']), {
      timeout: 5000,
    });
    // Terminal: no further read of the job.
    const after = reads(s);
    await sleep(EXPORT_POLL_MS * 2 + 200);
    expect(reads(s)).toBe(after);
    expect(seen).toEqual(['queued', 'compiling', 'completed']);
    await b.close();
  });

  it('stops reading when the backend closes, so no report comes after close()', async () => {
    const s = setup();
    const b = s.make();
    await connected(s, b);
    const seen: string[] = [];
    const job = await b.exports!.request(
      s.docId,
      { target: 'pdf' },
      { onProgress: (j: ExportJob) => seen.push(j.state) },
    );
    await b.close();
    s.files.jobs.get(job.id)!.state = 'compiling';
    const before = reads(s);
    await sleep(EXPORT_POLL_MS * 2 + 200);
    expect(reads(s)).toBe(before);
    expect(seen).toEqual(['queued']);
  });

  it('stops reading when the job is not found', async () => {
    const s = setup();
    const b = s.make();
    await connected(s, b);
    const seen: string[] = [];
    const job = await b.exports!.request(
      s.docId,
      { target: 'pdf' },
      { onProgress: (j: ExportJob) => seen.push(j.state) },
    );
    s.files.jobs.delete(job.id);
    await sleep(EXPORT_POLL_MS + 200);
    const after = reads(s);
    expect(after).toBeGreaterThan(0);
    await sleep(EXPORT_POLL_MS * 2 + 200);
    expect(reads(s)).toBe(after);
    expect(seen).toEqual(['queued']);
    await b.close();
  });

  it('keeps the request working when the listener throws', async () => {
    const s = setup();
    const b = s.make();
    await connected(s, b);
    const job = await b.exports!.request(
      s.docId,
      { target: 'pdf' },
      {
        onProgress: () => {
          throw new Error('the listener failed');
        },
      },
    );
    expect(job.state).toBe('queued');
    await b.close();
  });
});
