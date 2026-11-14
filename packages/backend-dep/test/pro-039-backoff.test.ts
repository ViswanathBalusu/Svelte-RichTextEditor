// What the client does when a channel closes with a code (PRO-039 criterion 5; 05 §5.8; lane
// V-PRO-035-051): `slow_consumer` makes it resume at once, and `unavailable` or `internal` make it
// back off, so no resume is sent before the server's `retryInMs` hint has passed. The ch.closed
// frames are injected with the mock session's push(); the resumes are read from the wire.
// Node.js only, in-memory network.
import { describe, expect, it } from 'vitest';
import { createDepBackend, type DepBackend } from '../src/index.ts';
import { LEGAL_GRANT, USERS, contractDocument } from './support/fixtures.ts';
import { MemoryNetwork } from './support/memory-network.ts';
import { MockDepServer } from './support/mock-server.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(pred: () => boolean, what: string, ms = 3000): Promise<void> {
  for (let waited = 0; !pred(); waited += 5) {
    if (waited > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

function setup() {
  const dep = new MockDepServer();
  const net = new MemoryNetwork(dep);
  const docId = dep.service.createDocument(contractDocument(), { grants: [LEGAL_GRANT] });
  const make = (): DepBackend =>
    createDepBackend({
      endpoint: dep.endpoint,
      getToken: async () => dep.mintToken(USERS.editor, { [docId]: 'editor' }),
      platform: { random: () => 0, ...net.platform() },
    });
  return { dep, net, docId, make };
}

/** The resumes the client sent, read from the wire, with the time each was seen. */
function resumesOf(net: MemoryNetwork): Array<Record<string, unknown>> {
  return net
    .decoded('c2s')
    .filter((f) => f['t'] === 'ch.open' && (f['d'] as { resume?: unknown }).resume !== undefined)
    .map((f) => (f['d'] as { resume: Record<string, unknown> }).resume);
}

async function joined(s: ReturnType<typeof setup>, b: DepBackend) {
  await b.connect();
  const content = await b.sync.loadContent(s.docId);
  const ch = await b.sync.open(s.docId, {
    resume: { seq: content.seq, incarnation: content.incarnation },
  });
  const states: string[] = [];
  ch.onState((st) => states.push(st.status));
  await until(() => states.includes('live'), 'live');
  const n = s.net
    .decoded('c2s')
    .filter((f) => f['t'] === 'ch.open')
    .at(-1)!['ch'] as number;
  return { n };
}

describe('a closed channel: resume at once, or back off for the hint (PRO-039 criterion 5)', () => {
  it('resumes at once when ch.closed says slow_consumer', async () => {
    const s = setup();
    const b = s.make();
    const { n } = await joined(s, b);
    const before = resumesOf(s.net).length;
    s.dep.sessions[0]!.push({
      t: 'ch.closed',
      ch: n,
      d: { code: 'slow_consumer', reason: 'the channel fell behind', retryInMs: 0 },
    });
    await until(() => resumesOf(s.net).length > before, 'a resume after slow_consumer');
    await b.close();
  });

  it.each(['unavailable', 'internal'] as const)(
    'backs off for the whole retryInMs hint when ch.closed says %s',
    async (code) => {
      const s = setup();
      const b = s.make();
      const { n } = await joined(s, b);
      const before = resumesOf(s.net).length;
      const retryInMs = 400;
      const t0 = Date.now();
      s.dep.sessions[0]!.push({
        t: 'ch.closed',
        ch: n,
        d: { code, reason: 'the channel is being moved', retryInMs },
      });
      // Half the hint passes with no resume on the wire: the client is backing off.
      await sleep(retryInMs / 2);
      expect(resumesOf(s.net).length).toBe(before);
      await until(() => resumesOf(s.net).length > before, `a resume after ${code}`);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(retryInMs - 5);
      await b.close();
    },
  );
});
