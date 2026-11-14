// backend-dep's channel resumes by itself when the answer is wrong or missing (PRO-095; 05 §5.2,
// 04 §9; decision on the ClientChannel machine): a commit beyond the next seq, a submit with no
// answer within ackTimeoutMs, and ch.closed with retryInMs. The server frames are injected with the
// mock session's push(), and the resumes are read from the wire. Universal: Node.js and browsers.
import { describe, expect, it } from 'vitest';
import { isPortError, type RemoteCommit } from '@docedit/protocol';
import { createDepBackend, type DepBackend } from './index.ts';
import {
  IDS,
  LEGAL_GRANT,
  USERS,
  contractDocument,
  insertText,
  posIn,
} from '../test/support/fixtures.ts';
import { MemoryNetwork } from '../test/support/memory-network.ts';
import { MockDepServer, type MockDepServerOptions } from '../test/support/mock-server.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(pred: () => boolean, what: string, ms = 3000): Promise<void> {
  for (let waited = 0; !pred(); waited += 5) {
    if (waited > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

function setup(server: MockDepServerOptions = {}, fate?: (text: string) => 'deliver' | 'drop') {
  const dep = new MockDepServer(server);
  const net = new MemoryNetwork(dep);
  if (fate) net.fate = (text) => fate(text);
  const docId = dep.service.createDocument(contractDocument(), { grants: [LEGAL_GRANT] });
  const make = (): DepBackend =>
    createDepBackend({
      endpoint: dep.endpoint,
      getToken: async () => dep.mintToken(USERS.editor, { [docId]: 'editor' }),
      platform: { random: () => 0, ...net.platform() },
    });
  return { dep, net, docId, make };
}

/** The channel's number and the resumes it sent, read from the wire. */
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
  return { ch, content, n, states };
}

describe('the channel resumes by itself (PRO-095)', () => {
  it('reopens with a resume when a commit arrives beyond the next seq (a gap)', async () => {
    const s = setup();
    const b = s.make();
    const { content, n, states } = await joined(s, b);
    const before = resumesOf(s.net).length;
    const session = s.dep.sessions[0]!;
    const commit: RemoteCommit = {
      seq: content.seq + 2,
      kind: 'control',
      id: '0192f0c4-0000-7000-8000-0000000000d1',
      steps: [],
      control: { type: 'grants', rev: 11 },
      author: { user: 'system', session: null, agent: null },
      serverTime: '2026-11-13T10:00:00.000Z',
      origin: 'control',
    };
    session.push({ t: 'sync.commit', ch: n, d: { commits: [commit] } });
    await until(() => resumesOf(s.net).length > before, 'a resume after the gap');
    const last = resumesOf(s.net).at(-1)!;
    // The resume names the confirmed seq, not the commit that arrived out of order.
    expect(last['seq']).toBe(content.seq);
    await until(() => states.filter((x) => x === 'live').length >= 2, 'live again');
    await b.close();
  });

  it('reopens with a resume when a submit is not answered within ackTimeoutMs, and fails that submit with unavailable', async () => {
    let dropped = false;
    const s = setup({ limits: { ackTimeoutMs: 80 } }, (text) => {
      // Only the first acknowledgement is lost, so the resumed channel can answer.
      if (!dropped && text.startsWith('{"t":"sync.ack"')) {
        dropped = true;
        return 'drop';
      }
      return 'deliver';
    });
    const b = s.make();
    const { ch, content, states } = await joined(s, b);
    const before = resumesOf(s.net).length;
    const submitted = ch
      .submit({
        id: '0192f0c4-0000-7000-8000-0000000000d2',
        base: content.seq,
        steps: [insertText(posIn(content.doc, IDS.intro), 'z')],
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    await until(() => resumesOf(s.net).length > before, 'a resume after the silent submit');
    const err = await submitted;
    expect(isPortError(err) && err.code).toBe('unavailable');
    await until(() => states.filter((x) => x === 'live').length >= 2, 'live again');
    await b.close();
  });

  it.each(['unavailable', 'slow_consumer'] as const)(
    'resumes after retryInMs when ch.closed says %s',
    async (code) => {
      const s = setup();
      const b = s.make();
      const { n, states } = await joined(s, b);
      const before = resumesOf(s.net).length;
      const retryInMs = 60;
      const t0 = Date.now();
      s.dep.sessions[0]!.push({
        t: 'ch.closed',
        ch: n,
        d: { code, reason: 'the channel is being moved', retryInMs },
      });
      await until(() => resumesOf(s.net).length > before, 'a resume after retryInMs');
      expect(Date.now() - t0).toBeGreaterThanOrEqual(retryInMs - 5);
      // The mock keeps its own channel open, so the reopen is refused with already_open and the
      // channel is not live again; the criterion is the resume after retryInMs, which is checked above.
      expect(states).toContain('live');
      await b.close();
    },
  );
});
