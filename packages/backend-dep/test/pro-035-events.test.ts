// Notifications as the client reads them (PRO-035 criteria 1 and 5; PRO-005; 05 section 5.6). An
// `event` message carries `type`, `resource`, optional `rev` and optional small `data`, and the
// client hands it on unchanged; an event type the client does not know does not break the channel.
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

/** Opens the document channel, waits for `live`, and records the events and states it delivers. */
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
  // The channel number the client sent with its ch.open (the wire, not the client's internals).
  const opened = s.net
    .decoded('c2s')
    .filter((f) => f['t'] === 'ch.open')
    .at(-1)!;
  return { events, states, ch: opened['ch'] as number };
}

describe('an event message as the client reads it (PRO-035 criterion 1)', () => {
  it('hands on type, resource, rev and data unchanged', async () => {
    const s = setup();
    const b = s.make();
    const { events, ch } = await openLive(s, b);
    const full = {
      type: 'export.completed',
      resource: '/exports/0192f0c4-0000-7000-8000-0000000000e1',
      rev: 4,
      data: { state: 'done', bytes: 1024 },
    } as Notification;
    s.server.sessions[0]!.push({ t: 'event', ch, d: full });
    await until(() => events.length >= 1, 'the full event');
    expect(events[0]).toStrictEqual(full);
    await b.close();
  });

  it('keeps an absent rev and an absent data absent', async () => {
    const s = setup();
    const b = s.make();
    const { events, ch } = await openLive(s, b);
    const bare: Notification = { type: 'document.updated', resource: `/documents/${s.docId}` };
    s.server.sessions[0]!.push({ t: 'event', ch, d: bare });
    await until(() => events.length >= 1, 'the bare event');
    expect(events[0]).toStrictEqual(bare);
    expect('rev' in events[0]!).toBe(false);
    expect('data' in events[0]!).toBe(false);
    await b.close();
  });
});

describe('an event type the client does not know (PRO-035 criterion 5; PRO-005)', () => {
  it('does not close or fail the channel, and later known events still arrive', async () => {
    const s = setup();
    const b = s.make();
    const { events, states, ch } = await openLive(s, b);
    const future = { type: 'x.future.thing', resource: '/x/later', data: { a: 1 } } as Notification;
    const known: Notification = { type: 'document.updated', resource: `/documents/${s.docId}` };
    const session = s.server.sessions[0]!;
    const before = states.length;
    session.push({ t: 'event', ch, d: future });
    session.push({ t: 'event', ch, d: known });
    await until(() => events.length >= 2, 'both events');
    expect(events.map((e) => e.type)).toEqual(['x.future.thing', 'document.updated']);
    expect(states.slice(before).some((st) => st.status === 'closed')).toBe(false);
    await b.close();
  });
});
