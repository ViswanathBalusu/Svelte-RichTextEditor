// PRO-026 criterion 1 (lane U-PRO-018-034): with `catchUp: "page"`, the client reads the missing
// commits over `GET /documents/{id}/commits` with `after` and `limit` (at most 200 per page), applies
// them in ascending order, and then takes `head + 1` as the next live commit. The server here serves
// pages of two commits, so one catch-up needs three reads. Node.js, over the in-memory network.
import { describe, expect, it } from 'vitest';
import type { RemoteCommit } from '@docedit/protocol';
import { createDepBackend, type DepBackend } from '../src/index.ts';
import { LEGAL_GRANT, USERS, contractDocument } from './support/fixtures.ts';
import { CatchUpServer } from './support/catch-up-server.ts';
import { MemoryNetwork } from './support/memory-network.ts';
import type { HttpRequest, HttpResponse, ServerSocket } from './support/memory-network.ts';
import { MockDepServer } from './support/mock-server.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(pred: () => boolean, what: string, ms = 3000): Promise<void> {
  for (let waited = 0; !pred(); waited += 5) {
    if (waited > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

function control(seq: number, rev: number): RemoteCommit {
  return {
    seq,
    kind: 'control',
    id: `0192f0c4-0000-7000-8000-${String(seq).padStart(12, '0')}`,
    steps: [],
    control: { type: 'grants', rev },
    author: { user: 'system', session: null, agent: null },
    serverTime: '2026-11-13T10:00:00.000Z',
    origin: 'control',
  };
}

/** A catch-up server that pages its commits by `after` and `limit`, and keeps the live sockets. */
class PagingServer extends CatchUpServer {
  readonly sockets: ServerSocket[] = [];
  /** The `limit` query of each page request, as sent (null when absent). */
  readonly pageLimits: Array<number | null> = [];
  /** The most commits one page returns, whatever the client asked for. */
  maxPage = 200;

  override accept(socket: ServerSocket): string | null {
    this.sockets.push(socket);
    return super.accept(socket);
  }

  override async http(req: HttpRequest): Promise<HttpResponse> {
    const url = new URL(req.url);
    if (req.method !== 'GET' || !/^\/v1\/documents\/[^/]+\/commits$/.test(url.pathname))
      return super.http(req);
    const after = Number(url.searchParams.get('after') ?? '0');
    const raw = url.searchParams.get('limit');
    this.pageLimits.push(raw === null ? null : Number(raw));
    this.pageRequests.push(after);
    const limit = Math.min(raw === null ? 200 : Number(raw), this.maxPage);
    const items = this.pageCommits.filter((c) => c.seq > after).slice(0, limit);
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items, nextCursor: null }),
    };
  }
}

describe('PRO-026 criterion 1: catch-up by page reads with after and limit, then goes live at head + 1', () => {
  it('reads three pages of at most 200 in ascending order, then receives head + 1 live', async () => {
    const dep = new MockDepServer();
    const server = new PagingServer(dep, ['page']);
    const net = new MemoryNetwork(server);
    const docId = dep.service.createDocument(contractDocument(), { grants: [LEGAL_GRANT] });
    const b: DepBackend = createDepBackend({
      endpoint: dep.endpoint,
      getToken: async () => dep.mintToken(USERS.editor, { [docId]: 'editor' }),
      platform: { random: () => 0, ...net.platform() },
    });
    await b.connect();
    const content = await b.sync.loadContent(docId);
    const ch = await b.sync.open(docId, {
      resume: { seq: content.seq, incarnation: content.incarnation },
    });
    const states: string[] = [];
    const received: number[] = [];
    ch.onState((st) => states.push(st.status));
    ch.onCommits((commits) => received.push(...commits.map((c) => c.seq)));
    await until(() => states.includes('live'), 'live');

    const base = content.seq;
    server.pageCommits = [1, 2, 3, 4, 5].map((i) => control(base + i, 10 + i));
    server.maxPage = 2;
    const before = net.decoded('c2s').filter((f) => f['t'] === 'ch.open').length;
    net.cut();
    await until(
      () => net.decoded('c2s').filter((f) => f['t'] === 'ch.open').length > before,
      'the resumed ch.open',
    );
    await until(() => states.filter((s) => s === 'live').length >= 2, 'live again');

    expect(server.openedModes).toEqual(['page']);
    // Each read asks for the commits after the last one it holds, never more than 200.
    expect(server.pageRequests).toEqual([base, base + 2, base + 4]);
    expect(server.pageLimits).toEqual([200, 200, 200]);
    expect(received).toEqual([base + 1, base + 2, base + 3, base + 4, base + 5]);

    // The next live commit is head + 1, and it is delivered after the pages.
    const ackChannel = net
      .decoded('s2c')
      .filter((f) => f['t'] === 'ch.opened')
      .at(-1)!['ch'];
    server.sockets.at(-1)!.send(
      JSON.stringify({
        t: 'sync.commit',
        ch: ackChannel,
        d: { commits: [control(base + 6, 16)] },
      }),
    );
    await until(() => received.includes(base + 6), 'the live commit at head + 1');
    expect(received).toEqual([1, 2, 3, 4, 5, 6].map((i) => base + i));
    await b.close();
  });
});
