// PRO-097 criterion 2, the part that the channel carries: thread events that the server sends on a
// live document channel reach the caller's `SyncChannel.onEvent` unchanged, in the order received,
// after the comment routes have been used. The criterion also says that backend-dep "applies" them;
// that reading is open (lane U-PRO-086-102, ADR 0314 decision 10), so this test does not tick it.
// Run against the in-memory network, so the frames are the ones on the wire. Node.js only.
import { describe, expect, it } from 'vitest';
import type { ChannelState, Notification } from '@docedit/protocol';
import { createDepBackend, type DepBackend, type DepBackendOptions } from '../src/index.ts';
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
  const server = new MockDepServer();
  const net = new MemoryNetwork(server);
  const docId = server.service.createDocument(contractDocument(), { grants: [LEGAL_GRANT] });
  const make = (extra: Partial<DepBackendOptions> = {}): DepBackend =>
    createDepBackend({
      endpoint: server.endpoint,
      getToken: async () => server.mintToken(USERS.editor, { [docId]: 'editor' }),
      ...extra,
      platform: { random: () => 0, ...net.platform(), ...extra.platform },
    });
  return { server, net, docId, make };
}

async function openLive(s: ReturnType<typeof setup>, b: DepBackend) {
  await b.connect();
  const content = await b.sync.loadContent(s.docId);
  const ch = await b.sync.open(s.docId, {
    resume: { seq: content.seq, incarnation: content.incarnation },
  });
  const events: Notification[] = [];
  const states: ChannelState[] = [];
  ch.onEvent((e) => events.push(e));
  ch.onState((st) => states.push(st));
  await until(() => states.some((st) => st.status === 'live'), 'live');
  const opened = s.net
    .decoded('c2s')
    .filter((f) => f['t'] === 'ch.open')
    .at(-1)!;
  return { events, ch: opened['ch'] as number, seq: content.seq };
}

describe('thread events on the document channel (PRO-097 criterion 2, channel part)', () => {
  it('delivers thread and comment events unchanged and in the order received', async () => {
    const s = setup();
    const b = s.make();
    const { events, ch, seq } = await openLive(s, b);
    const threadId = '0192f0c4-0000-7000-8000-0000000000a1';
    const sent: Notification[] = [
      { type: 'thread.created', resource: `/threads/${threadId}`, rev: 1, data: { state: 'open' } },
      { type: 'comment.created', resource: `/threads/${threadId}`, rev: 2 },
      {
        type: 'thread.resolved',
        resource: `/threads/${threadId}`,
        rev: 3,
        data: { state: 'resolved' },
      },
    ] as Notification[];
    for (const d of sent) s.server.sessions[0]!.push({ t: 'event', ch, d });
    await until(() => events.length >= sent.length, 'the three thread events');
    expect(events).toStrictEqual(sent);
    // The events do not move the document: the channel's commit sequence is unchanged.
    const again = await b.sync.loadContent(s.docId);
    expect(again.seq).toBe(seq);
    await b.close();
  });

  it('stops delivering thread events after close()', async () => {
    const s = setup();
    const b = s.make();
    const { events, ch } = await openLive(s, b);
    await b.close();
    s.server.sessions[0]?.push({
      t: 'event',
      ch,
      d: { type: 'thread.deleted', resource: '/threads/x', rev: 9 } as Notification,
    });
    await sleep(20);
    expect(events.some((e) => e.type === 'thread.deleted')).toBe(false);
  });
});
