// Presence through the data plane (05 §5.4; 04 §11; SYN-035, PRO-031): identity from the session,
// schema and size limits, the rate limit by coalescing, joins and departures, and no storage.
import { afterEach, describe, expect, it } from 'vitest';
import type { DepClient } from './client.ts';
import { startPlane, until, type Plane } from './support.ts';

let planes: Plane[] = [];
async function plane(...args: Parameters<typeof startPlane>): Promise<Plane> {
  const p = await startPlane(...args);
  planes.push(p);
  return p;
}
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

const state = (anchor: number, status = 'active') => ({
  selection: { anchor, head: anchor },
  scope: 'body',
  status,
});

async function two(p: Plane) {
  const doc = await p.createDocument();
  const a = await p.client('alice', { [doc]: 'owner' }, { name: 'Alice' });
  const b = await p.client('carol', { [doc]: 'editor' }, { name: 'Carol' });
  await a.open(1, doc);
  await b.open(1, doc);
  return { doc, a, b };
}

const session = (c: DepClient) => c.log.find((m) => m.t === 'welcome')!.d!['session'] as string;

describe('presence (SYN-035, PRO-031)', () => {
  it('relays an update with the identity the server derives from the session', async () => {
    const p = await plane();
    const { a, b } = await two(p);
    a.send({
      t: 'presence.update',
      ch: 1,
      d: { seq: 0, state: { ...state(5), user: { id: 'carol' }, session: 'forged' } },
    });
    const ps = await b.take((m) => m.t === 'presence.state');
    expect(ps.d).toEqual({
      peers: [
        { session: session(a), user: { id: 'host-alice', name: 'Alice' }, seq: 0, state: state(5) },
      ],
      left: [],
    });
  });

  it('refuses a state above presenceBytes or outside its schema, without closing', async () => {
    const p = await plane({ settings: { limits: { presenceBytes: 200 } } });
    const { a, b } = await two(p);
    a.send({
      t: 'presence.update',
      ch: 1,
      d: { seq: 0, state: { ...state(1), scope: 'x'.repeat(300) } },
    });
    a.send({
      t: 'presence.update',
      id: 'bad',
      ch: 1,
      d: { seq: 0, state: { selection: { anchor: 1 } } },
    });
    expect((await a.take((m) => m.re === 'bad')).d).toMatchObject({
      code: 'bad_message',
      fatal: false,
    });
    a.send({ t: 'presence.update', ch: 1, d: { seq: 0, state: state(2) } });
    const ps = await b.take((m) => m.t === 'presence.state');
    expect(ps.d!['peers'][0].state).toEqual(state(2));
    expect(b.all('presence.state')).toHaveLength(1);
    expect(a.ws.readyState).toBe(a.ws.OPEN);
  });

  it('coalesces more than presenceHz updates a second, keeping the latest, without closing', async () => {
    const p = await plane({ settings: { limits: { presenceHz: 5 } } });
    const { a, b } = await two(p);
    const started = Date.now();
    for (let i = 0; i < 40; i++)
      a.send({ t: 'presence.update', ch: 1, d: { seq: 0, state: state(i) } });
    await until(
      () => b.all('presence.state').at(-1)?.d!['peers'][0].state.selection.anchor === 39,
      3000,
    );
    const got = b.all('presence.state');
    const seconds = (Date.now() - started) / 1000;
    expect(got.length).toBeLessThanOrEqual(Math.ceil(seconds * 5) + 1);
    expect(got.length).toBeLessThan(40);
    expect(a.ws.readyState).toBe(a.ws.OPEN);
  });

  it('tells a joining channel who is there, and the others who left', async () => {
    const p = await plane();
    const { doc, a, b } = await two(p);
    a.send({ t: 'presence.update', ch: 1, d: { seq: 0, state: state(3) } });
    await b.take((m) => m.t === 'presence.state');
    const c = await p.client('bob', { [doc]: 'editor' });
    await c.open(1, doc);
    const joined = await c.take((m) => m.t === 'presence.state');
    expect(joined.d!['peers'].map((x: { session: string }) => x.session)).toEqual([session(a)]);
    a.close();
    const left = await b.take((m) => m.t === 'presence.state' && m.d!['left'].length > 0);
    expect(left.d).toEqual({ peers: [], left: [session(a)] });
  });

  it('never stores presence: the log stays empty and a new room shows nobody', async () => {
    const p = await plane();
    const { doc, a } = await two(p);
    for (let i = 0; i < 5; i++)
      a.send({ t: 'presence.update', ch: 1, d: { seq: 0, state: state(i) } });
    await new Promise((r) => setTimeout(r, 100));
    expect(await p.stores.logs.read(p.ref(doc))).toEqual([]);
    // A restart: another node over the same storage.
    const q = await plane({ stores: p.stores, checkpoints: p.checkpoints, tenant: p.tenant });
    const c = await q.client('bob', { [doc]: 'editor' });
    await c.open(1, doc);
    await new Promise((r) => setTimeout(r, 100));
    expect(c.all('presence.state')).toHaveLength(0);
  });

  it('relays nothing when the server does not offer presence', async () => {
    const p = await plane({ settings: { features: ['regions', 'suggest-enforced'] } });
    const { a, b } = await two(p);
    expect(a.log.find((m) => m.t === 'welcome')!.d!['features']).not.toContain('presence');
    a.send({ t: 'presence.update', ch: 1, d: { seq: 0, state: state(1) } });
    await new Promise((r) => setTimeout(r, 100));
    expect(b.all('presence.state')).toHaveLength(0);
  });
});
