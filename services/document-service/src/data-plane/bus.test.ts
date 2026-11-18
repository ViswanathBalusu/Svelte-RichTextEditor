// The bus between nodes (BE-063): the in-memory end that tests use, and the Valkey streams adapter.
// The Valkey cases run against a real server when `DOCEDIT_VALKEY_URL` names one (for example
// `redis://127.0.0.1:56375`) and are skipped otherwise; each case uses a key prefix of its own.
import net from 'node:net';
import { uuid7 } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryBusNetwork, type Bus, type BusMessage } from './bus.ts';
import { parseValkeyUrl, ValkeyClient } from './valkey-buckets.ts';
import { ValkeyBus } from './valkey-bus.ts';

const liveUrl = process.env['DOCEDIT_VALKEY_URL'];

/** Waits until `check` holds, polling. */
async function until(check: () => boolean, ms = 4000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A seeded generator, so that a run of faults can be repeated. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('the in-memory bus', () => {
  it('delivers a topic to its subscribers in publishing order, with the sender named', async () => {
    const net_ = new MemoryBusNetwork();
    const a = net_.connect('node-a');
    const b = net_.connect('node-b');
    const got: BusMessage[] = [];
    await b.subscribe('t', (m) => got.push(m));
    for (let i = 0; i < 50; i++) await a.publish('t', String(i));
    await until(() => got.length === 50);
    expect(got.map((m) => m.body)).toEqual(Array.from({ length: 50 }, (_, i) => String(i)));
    expect(new Set(got.map((m) => m.from))).toEqual(new Set(['node-a']));
  });

  it('keeps the order of a topic while messages are delayed, and hears only what follows subscribe', async () => {
    const net_ = new MemoryBusNetwork(seeded(7));
    net_.faults.delayMs = 15;
    const a = net_.connect('node-a');
    const b = net_.connect('node-b');
    await a.publish('t', 'before');
    const got: string[] = [];
    await b.subscribe('t', (m) => got.push(m.body));
    for (let i = 0; i < 30; i++) await a.publish('t', String(i));
    await until(() => got.length >= 30, 4000, 'delayed delivery');
    expect(got).toEqual(Array.from({ length: 30 }, (_, i) => String(i)));
  });

  it('drops messages and refuses publishes when told to, and never throws', async () => {
    const net_ = new MemoryBusNetwork(seeded(3));
    const a = net_.connect('node-a');
    const b = net_.connect('node-b');
    const got: string[] = [];
    await b.subscribe('t', (m) => got.push(m.body));
    net_.faults.drop = 0.5;
    const results: boolean[] = [];
    for (let i = 0; i < 200; i++) results.push(await a.publish('t', String(i)));
    await until(() => got.length === results.filter(Boolean).length);
    expect(got.length).toBeGreaterThan(50);
    expect(got.length).toBeLessThan(150);
    expect(a.stats.failed).toBe(results.filter((r) => !r).length);
    net_.faults.drop = 0;
    net_.faults.down = true;
    expect(await a.publish('t', 'x')).toBe(false);
    await a.close();
    expect(await a.publish('t', 'y')).toBe(false);
  });
});

describe.skipIf(liveUrl === undefined)('the Valkey bus (BE-063; owner decision 136)', () => {
  const buses: Bus[] = [];
  const clients: ValkeyClient[] = [];
  afterEach(async () => {
    for (const b of buses.splice(0)) await b.close();
    for (const c of clients.splice(0)) c.close();
  });
  const open = (node: string, prefix: string, extra: Partial<{ url: string }> = {}): ValkeyBus => {
    const b = new ValkeyBus({
      node,
      url: extra.url ?? liveUrl!,
      prefix,
      timeoutMs: 1000,
      blockMs: 100,
    });
    buses.push(b);
    return b;
  };
  const raw = (): ValkeyClient => {
    const c = new ValkeyClient(parseValkeyUrl(liveUrl!), 2000);
    clients.push(c);
    return c;
  };

  it('delivers a topic to a subscriber on another node in order, once each', async () => {
    const prefix = `docedit:bus:w5-be063:${uuid7()}:`;
    const a = open('node-a', prefix);
    const b = open('node-b', prefix);
    const got: BusMessage[] = [];
    await b.subscribe('room', (m) => got.push(m));
    for (let i = 0; i < 100; i++) expect(await a.publish('room', `m${i}`)).toBe(true);
    await until(() => got.length >= 100, 4000, '100 messages');
    await new Promise((r) => setTimeout(r, 200));
    expect(got.map((m) => m.body)).toEqual(Array.from({ length: 100 }, (_, i) => `m${i}`));
    expect(got.every((m) => m.from === 'node-a')).toBe(true);
    expect(a.stats.published).toBe(100);
    await raw().command('DEL', `${prefix}room`);
  });

  it('does not deliver what was published before the subscription, nor to an unsubscribed topic', async () => {
    const prefix = `docedit:bus:w5-be063:${uuid7()}:`;
    const a = open('node-a', prefix);
    const b = open('node-b', prefix);
    await a.publish('t', 'old');
    await new Promise((r) => setTimeout(r, 20));
    const got: string[] = [];
    const other: string[] = [];
    const sub = await b.subscribe('t', (m) => got.push(m.body));
    await b.subscribe('u', (m) => other.push(m.body));
    await a.publish('t', 'new');
    await until(() => got.length === 1);
    sub.close();
    await a.publish('t', 'after-close');
    await new Promise((r) => setTimeout(r, 400));
    expect(got).toEqual(['new']);
    expect(other).toEqual([]);
    await raw().command('DEL', `${prefix}t`, `${prefix}u`);
  });

  it('keeps working after the server is flushed: what is lost is lost, what follows is delivered', async () => {
    const prefix = `docedit:bus:w5-be063:${uuid7()}:`;
    const a = open('node-a', prefix);
    const b = open('node-b', prefix);
    const got: string[] = [];
    await b.subscribe('t', (m) => got.push(m.body));
    await a.publish('t', 'one');
    await until(() => got.length === 1);
    // A flush deletes every key of the server, as a restart without persistence would.
    await raw().command('FLUSHALL');
    await a.publish('t', 'two');
    await until(() => got.includes('two'), 4000, 'a message after the flush');
    expect(got).toEqual(['one', 'two']);
    await raw().command('DEL', `${prefix}t`);
  });

  it('answers false and throws nothing when the server cannot be reached', async () => {
    const closed = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        if (addr === null || typeof addr === 'string') return reject(new Error('no port'));
        srv.close(() => resolve(addr.port));
      });
    });
    const a = open('node-a', `docedit:bus:w5-be063:${uuid7()}:`, {
      url: `redis://127.0.0.1:${closed}`,
    });
    expect(await a.publish('t', 'x')).toBe(false);
    const sub = await a.subscribe('t', () => undefined);
    await until(() => a.readFailures > 0, 4000, 'a failed read');
    sub.close();
    expect(a.stats.failed).toBe(1);
  });
});
