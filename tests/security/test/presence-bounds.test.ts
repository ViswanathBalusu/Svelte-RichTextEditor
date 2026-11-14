/**
 * SEC-018 criterion 3 — presence updates above the per-client cap, and invalid or oversized
 * presence, are dropped or rejected, so the room's presence traffic stays bounded (10 §3.2; 04 §11,
 * §12). The limits are the service's own settings (presenceHz, presenceBytes; settings.ts). The
 * test sends the updates over the wire and counts what a peer receives.
 *
 * Memory only: the presence relay is in-process state, and the PostgreSQL variant adds nothing here.
 * The room's memory bound is not observable from the wire, so it is not proved here (see the story's
 * Notes).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { documentWithRegions, startHarness, type Harness } from './support/harness.ts';
import { WireClient, type Received } from './support/wire.ts';

const PRESENCE_HZ = 10; // settings.ts: presenceHz
const PRESENCE_BYTES = 1024; // settings.ts: presenceBytes

const validState = {
  selection: { anchor: 1, head: 1 },
  scope: 'body',
  status: 'active',
};

describe('SEC-018 presence updates are capped, and invalid or oversized presence is dropped (memory)', () => {
  let h: Harness;
  let doc: string;
  beforeAll(async () => {
    h = await startHarness('memory');
    doc = await h.createDocument(h.a, documentWithRegions());
  });
  afterAll(async () => {
    await h?.close();
  });

  const open = async (sub: string) => {
    const features = ['regions', 'presence'];
    const token = await h.mintToken(h.a, sub, { [doc]: 'editor' });
    const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
    const welcome = await c.hello(token, { features });
    await c.open(1, doc, { features });
    return { c, session: welcome.d?.['session'] as string };
  };

  /** The presence states a peer has received that name the sender's session (a relayed update). */
  const relayedFrom = (msgs: Received[], session: string) =>
    msgs.filter((m) => {
      const peers = m.d?.['peers'];
      return (
        Array.isArray(peers) && peers.some((p) => (p as { session?: string }).session === session)
      );
    });

  it('relays at most presenceHz updates a second to a peer, however fast the sender publishes', async () => {
    const a = await open('pia');
    const b = await open('pib');
    try {
      // Prime the peer: one update lets B learn A's session before the burst is counted.
      a.c.send({ t: 'presence.update', ch: 1, d: { seq: 0, state: validState } });
      await b.c.take(
        (m) => m.t === 'presence.state' && relayedFrom([m], a.session).length > 0,
        5000,
        'prime',
      );
      const before = relayedFrom(b.c.all('presence.state', 1), a.session).length;

      // A burst of 200 updates in one tight loop.
      const burst = 200;
      const t0 = Date.now();
      for (let i = 1; i <= burst; i++) {
        a.c.send({
          t: 'presence.update',
          ch: 1,
          d: { seq: i, state: { ...validState, selection: { anchor: i % 50, head: i % 50 } } },
        });
      }
      await new Promise((r) => setTimeout(r, 400));
      const elapsed = Date.now() - t0;
      const relayed = relayedFrom(b.c.all('presence.state', 1), a.session).length - before;

      // The first update goes at once; the rest are coalesced to one per interval, so the number
      // relayed is bounded by the interval count over the time the burst took, plus the trailing
      // update. It is never the whole burst.
      const interval = 1000 / PRESENCE_HZ;
      expect(relayed).toBeGreaterThanOrEqual(1);
      expect(relayed).toBeLessThanOrEqual(2 + Math.ceil(elapsed / interval));
      expect(relayed).toBeLessThan(burst);
    } finally {
      a.c.terminate();
      b.c.terminate();
    }
  });

  it('drops an oversized presence state, and relays nothing for it', async () => {
    const a = await open('pio');
    const b = await open('pob');
    try {
      const bulk = 'x'.repeat(PRESENCE_BYTES * 2);
      // A `status` far above the byte limit. Where the codec refuses the field outright, the
      // connection may close instead; either way no relayed state carries it.
      a.c.send({
        t: 'presence.update',
        ch: 1,
        d: { seq: 1, state: { ...validState, status: bulk } },
      });
      await new Promise((r) => setTimeout(r, 300));
      const relayed = relayedFrom(b.c.all('presence.state', 1), a.session);
      expect(relayed.length).toBe(0);
    } finally {
      a.c.terminate();
      b.c.terminate();
    }
  });

  it('rejects an invalid presence state (a missing selection), and relays nothing for it', async () => {
    const a = await open('pii');
    const b = await open('pij');
    try {
      a.c.send({
        t: 'presence.update',
        ch: 1,
        d: { seq: 1, state: { scope: 'body', status: 'active' } },
      });
      await new Promise((r) => setTimeout(r, 300));
      const relayed = relayedFrom(b.c.all('presence.state', 1), a.session);
      expect(relayed.length).toBe(0);
    } finally {
      a.c.terminate();
      b.c.terminate();
    }
  });
});
