// The engine of a channel is the one negotiated for the session (05 §5.1, §5.2; SYN-046
// criterion 4). Through the data plane with real WebSocket clients over MemoryStore: `hello.engines`
// is kept for the session, and a `ch.open.engine` outside that list is refused with
// `unsupported_engine` before any room is acquired.
import { afterEach, describe, expect, it } from 'vitest';
import { DepClient } from './client.ts';
import { startPlane, type Plane } from './support.ts';

let planes: Plane[] = [];
let clients: DepClient[] = [];
afterEach(async () => {
  for (const c of clients) c.terminate();
  for (const p of planes) await p.close();
  planes = [];
  clients = [];
});

async function plane(): Promise<Plane> {
  const p = await startPlane();
  planes.push(p);
  return p;
}

/** A client that says hello with its own engine list. */
async function clientWith(p: Plane, doc: string, engines: unknown[]): Promise<DepClient> {
  const c = await DepClient.connect(p.url);
  clients.push(c);
  const w = await c.hello(p.tokens.issue({ user: 'alice', docs: { [doc]: 'owner' } }), { engines });
  expect(w.t).toBe('welcome');
  return c;
}

describe('SYN-046 criterion 4: the channel engine is the one negotiated in hello', () => {
  it('opens a channel whose engine was negotiated', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const c = await clientWith(p, doc, ['yjs/1', 'pm-steps/1']);
    const r = await c.open(1, doc, { engine: 'pm-steps/1' });
    expect(r.t).toBe('ch.opened');
    expect(p.plane.host.rooms).toHaveLength(1);
  });

  it('refuses an engine the server serves but the client did not offer in hello, and opens no room', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    // The server serves pm-steps/1, but this session negotiated nothing in common.
    const c = await clientWith(p, doc, ['yjs/1']);
    const r = await c.open(1, doc, { engine: 'pm-steps/1' });
    expect(r).toMatchObject({ t: 'ch.rejected', ch: 1, d: { code: 'unsupported_engine' } });
    expect(typeof r.d!['message']).toBe('string');
    expect(p.plane.host.rooms).toHaveLength(0);
  });

  it('refuses an engine the client offered but the server does not serve, and opens no room', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const c = await clientWith(p, doc, ['yjs/1', 'pm-steps/1']);
    const r = await c.open(1, doc, { engine: 'yjs/1' });
    expect(r).toMatchObject({ t: 'ch.rejected', d: { code: 'unsupported_engine' } });
    expect(p.plane.host.rooms).toHaveLength(0);
  });

  it('keeps the negotiation per session: another session that offered the engine opens it', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const without = await clientWith(p, doc, ['yjs/1']);
    const withIt = await clientWith(p, doc, ['pm-steps/1']);
    expect((await without.open(1, doc)).d!['code']).toBe('unsupported_engine');
    expect((await withIt.open(1, doc)).t).toBe('ch.opened');
    expect(p.plane.host.rooms).toHaveLength(1);
  });
});
