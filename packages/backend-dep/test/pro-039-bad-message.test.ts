// What the client does when the server closes the socket with 4400, "malformed message" (PRO-039
// criterion 6; 05 §5.7, §5.8: `bad_message` is not retryable, "report a bug"): the session ends,
// the open channel closes with `bad_message`, and nothing reconnects or resumes. `ch.closed`
// cannot carry `bad_message` on the wire (its code list has no such member), so the close code is
// the way this reaches the client. Node.js only, in-memory network.
import { classifyClose } from '@docedit/protocol/client';
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

const connects = (net: MemoryNetwork): number =>
  net.decoded('c2s').filter((f) => f['t'] === 'hello').length;

describe('bad_message is not retried (PRO-039 criterion 6)', () => {
  it('classifies a 4400 close as bad_message with no reconnect, whatever hint came before', () => {
    expect(classifyClose(4400)).toEqual({ code: 'bad_message', reconnect: 'no' });
    expect(
      classifyClose(4400, { code: 'bad_message', message: 'x', retryAfterMs: 50 } as never),
    ).toEqual({ code: 'bad_message', reconnect: 'no' });
  });

  it('ends the channel with bad_message after a 4400 close and does not reconnect', async () => {
    const s = setup();
    const b = s.make();
    await b.connect();
    const content = await b.sync.loadContent(s.docId);
    const ch = await b.sync.open(s.docId, {
      resume: { seq: content.seq, incarnation: content.incarnation },
    });
    const closed: Array<string | null> = [];
    let live = false;
    ch.onState((st) => {
      if (st.status === 'live') live = true;
      if (st.status === 'closed') closed.push(st.code);
    });
    await until(() => live, 'live');
    const hellos = connects(s.net);
    (
      s.dep.sessions[0] as unknown as { socket: { close(c: number, r: string): void } }
    ).socket.close(4400, 'malformed message');
    await until(() => closed.length > 0, 'the channel to end');
    expect(closed).toEqual(['bad_message']);
    // Long enough for any backoff of this client (the delay is 0 to 1 s) to have fired.
    await sleep(1500);
    expect(connects(s.net)).toBe(hellos);
    await b.close();
  });
});
