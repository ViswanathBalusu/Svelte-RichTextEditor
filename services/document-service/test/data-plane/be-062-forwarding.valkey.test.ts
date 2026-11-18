// Channel forwarding over a real Valkey (BE-062; BE-063 criteria 1 and 4; owner decision 136). The
// same flows as `be-062-forwarding.test.ts`, with the bus on Valkey streams. Runs when
// `DOCEDIT_VALKEY_URL` names a server (for example `redis://127.0.0.1:56375`); skipped otherwise.
import net from 'node:net';
import { uuid7 } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { routeDocument } from '../../src/control-plane/room-routing.ts';
import { ValkeyBus } from '../../src/data-plane/valkey-bus.ts';
import { insertText } from './client.ts';
import { cluster, intro, type Cluster } from './forwarding-support.ts';
import type { Plane } from './support.ts';

const liveUrl = process.env['DOCEDIT_VALKEY_URL'];
const NODES = ['node-a', 'node-b'];

let c: Cluster | null = null;
const buses: ValkeyBus[] = [];
afterEach(async () => {
  await c?.close();
  c = null;
  for (const b of buses.splice(0)) await b.close();
});

async function docFor(p: Plane, owner: string): Promise<string> {
  for (let i = 0; i < 60; i++) {
    const doc = await p.createDocument();
    if (routeDocument(doc, NODES) === owner) return doc;
  }
  throw new Error('no document routes to ' + owner);
}

const bus = (node: string, prefix: string, url = liveUrl!): ValkeyBus => {
  const b = new ValkeyBus({ node, url, prefix, timeoutMs: 1000, blockMs: 100 });
  buses.push(b);
  return b;
};

describe.skipIf(liveUrl === undefined)('forwarding over Valkey streams', () => {
  it('forwards a channel, carries commits and presence both ways, and keeps the log of the owner', async () => {
    const prefix = `docedit:bus:w5-be062:${uuid7()}:`;
    c = cluster();
    const a = await c.start('node-a', bus('node-a', prefix));
    const b = await c.start('node-b', bus('node-b', prefix));
    const doc = await docFor(a, 'node-a');
    const alice = await a.client('alice', { [doc]: 'owner' }, { name: 'Alice' });
    const bob = await b.client('bob', { [doc]: 'editor' }, { name: 'Bob' });
    expect((await alice.open(1, doc)).t).toBe('ch.opened');
    expect((await bob.open(1, doc)).t).toBe('ch.opened');
    expect(a.plane.host.rooms).toHaveLength(1);
    expect(b.plane.host.rooms).toHaveLength(0);

    for (let i = 0; i < 20; i++) {
      const ack = await bob.submit(1, { base: i, steps: [insertText(intro(), `${i} `)] });
      expect(ack.t).toBe('sync.ack');
    }
    await alice.take(
      (m) =>
        m.t === 'sync.commit' &&
        (m.d as { commits: Array<{ seq: number }> }).commits.some((x) => x.seq === 20),
      4000,
      'the 20th commit on the owner',
    );
    const seen = alice
      .all('sync.commit')
      .flatMap((m) => (m.d as { commits: Array<{ seq: number }> }).commits.map((x) => x.seq));
    expect(seen).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect((await c.mem.read(a.ref(doc), 1)).map((x) => x.seq)).toEqual(seen);

    const state = (n: number) => ({
      selection: { anchor: n, head: n },
      scope: 'body',
      status: 'active',
    });
    alice.send({ t: 'presence.update', ch: 1, d: { seq: 0, state: state(2) } });
    await bob.take(
      (m) => m.t === 'presence.state' && JSON.stringify(m.d).includes('Alice'),
      4000,
      'presence of Alice on the forwarded channel',
    );
    bob.send({ t: 'presence.update', ch: 1, d: { seq: 0, state: state(5) } });
    await alice.take(
      (m) => m.t === 'presence.state' && JSON.stringify(m.d).includes('Bob'),
      4000,
      'presence of Bob on the owner',
    );
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
  });

  it('serves the rooms a node owns when its Valkey cannot be reached, and refuses a channel that needs forwarding', async () => {
    const closed = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        if (addr === null || typeof addr === 'string') return reject(new Error('no port'));
        srv.close(() => resolve(addr.port));
      });
    });
    const prefix = `docedit:bus:w5-be062:${uuid7()}:`;
    c = cluster();
    const dead = `redis://127.0.0.1:${closed}`;
    const a = await c.start('node-a', bus('node-a', prefix, dead));
    const b = await c.start('node-b', bus('node-b', prefix, dead), { openTimeoutMs: 600 });
    const doc = await docFor(a, 'node-a');
    const alice = await a.client('alice', { [doc]: 'owner' });
    expect((await alice.open(1, doc)).t).toBe('ch.opened');
    expect((await alice.submit(1, { base: 0, steps: [insertText(intro(), 'a ')] })).t).toBe(
      'sync.ack',
    );
    const bob = await b.client('bob', { [doc]: 'editor' });
    const refused = await bob.open(1, doc);
    expect(refused.t).toBe('ch.rejected');
    expect(refused.d).toMatchObject({ code: 'unavailable' });
    // The commit log is whole, and a client that goes to the owner directly is served.
    const direct = await a.client('bob', { [doc]: 'editor' });
    expect((await direct.open(1, doc)).t).toBe('ch.opened');
    expect((await c.mem.read(a.ref(doc), 1)).map((x) => x.seq)).toEqual([1]);
  });
});
