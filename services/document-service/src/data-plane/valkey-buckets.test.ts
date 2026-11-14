/**
 * Tests of the Valkey-shared token buckets (BE-063). The encoding, the reply parser and the local
 * fallback run everywhere. The shared cases run against a real Valkey server when
 * `DOCEDIT_VALKEY_URL` names one (for example `redis://127.0.0.1:56360`); each case uses its own
 * key prefix and deletes what it wrote.
 */
import net from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { encodeCommand, parseReply, ValkeyTokenBuckets } from './valkey-buckets.ts';

const liveUrl = process.env['DOCEDIT_VALKEY_URL'];

/** A port with nothing listening on it: bound, read, and released. */
async function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') return reject(new Error('no port'));
      srv.close(() => resolve(addr.port));
    });
  });
}

describe('RESP encoding and reply parsing (BE-063)', () => {
  it('encodes a command with byte lengths, not character counts', () => {
    const wire = encodeCommand(['SET', 'k', 'é']).toString('utf8');
    expect(wire).toBe('*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$2\r\né\r\n');
  });

  it('answers undefined for a reply that is not complete yet', () => {
    expect(parseReply(Buffer.from('$5\r\nab'), 0)).toBeUndefined();
    expect(parseReply(Buffer.from('*2\r\n:1\r\n'), 0)).toBeUndefined();
    expect(parseReply(Buffer.from(':12'), 0)).toBeUndefined();
  });

  it('parses integers, bulk strings, nulls and arrays', () => {
    expect(parseReply(Buffer.from(':42\r\n'), 0)).toEqual({ value: 42, next: 5 });
    expect(parseReply(Buffer.from('$-1\r\n'), 0)).toEqual({ value: null, next: 5 });
    expect(parseReply(Buffer.from('$3\r\nhé\r\n'), 0)?.value).toBe('hé');
    expect(parseReply(Buffer.from('*2\r\n:1\r\n$-1\r\n'), 0)?.value).toEqual([1, null]);
  });

  it('throws on a server error reply', () => {
    expect(() => parseReply(Buffer.from('-ERR boom\r\n'), 0)).toThrow('ERR boom');
  });
});

describe('ValkeyTokenBuckets without a server (BE-063 criterion 4)', () => {
  it('answers from a local bucket of the same settings when Valkey cannot be reached', async () => {
    const port = await closedPort();
    const store = new ValkeyTokenBuckets({
      url: `redis://127.0.0.1:${port}`,
      prefix: 'docedit:rl:U-BE-057-070:unreachable:',
      timeoutMs: 500,
    });
    try {
      const s = { capacity: 1, refillPerSecond: 0.001 };
      expect(await store.take('address', s, 0)).toBe(0);
      expect(await store.take('address', s, 0)).toBeGreaterThan(0);
      expect(store.stats.shared).toBe(0);
      expect(store.stats.degraded).toBe(2);
    } finally {
      store.close();
    }
  });
});

describe.skipIf(liveUrl === undefined)('ValkeyTokenBuckets against Valkey (BE-063)', () => {
  const run = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const prefix = `docedit:rl:U-BE-057-070:${run}:`;
  const stores: ValkeyTokenBuckets[] = [];
  const open = (): ValkeyTokenBuckets => {
    const s = new ValkeyTokenBuckets({ url: liveUrl!, prefix, timeoutMs: 2000 });
    stores.push(s);
    return s;
  };

  afterAll(async () => {
    // Remove only the keys this run wrote: everything under its own prefix.
    const cleaner = new ValkeyTokenBuckets({ url: liveUrl!, prefix, timeoutMs: 2000 });
    try {
      const keys = await cleaner.raw('KEYS', `${prefix}*`);
      if (Array.isArray(keys) && keys.length > 0) {
        await cleaner.raw('DEL', ...(keys as string[]));
      }
    } finally {
      cleaner.close();
      for (const s of stores) s.close();
    }
  });

  it('shares one bucket between two nodes', async () => {
    const nodeA = open();
    const nodeB = open();
    const s = { capacity: 3, refillPerSecond: 0.001 };
    const key = `tenant-a\u0000user-1-${run}`;
    expect(await nodeA.take(key, s, 0)).toBe(0);
    expect(await nodeB.take(key, s, 0)).toBe(0);
    expect(await nodeA.take(key, s, 0)).toBe(0);
    // Three tokens are gone whichever node took them.
    expect(await nodeB.take(key, s, 0)).toBeGreaterThan(0);
    expect(await nodeA.take(key, s, 0)).toBeGreaterThan(0);
    expect(nodeA.stats.degraded + nodeB.stats.degraded).toBe(0);
  });

  it('never admits more than the capacity under concurrent takes from two nodes', async () => {
    const nodeA = open();
    const nodeB = open();
    const s = { capacity: 5, refillPerSecond: 0 };
    const key = `race-${run}`;
    const takes: Promise<number>[] = [];
    for (let i = 0; i < 40; i++) {
      takes.push((i % 2 === 0 ? nodeA : nodeB).take(key, s, 0));
    }
    const waits = await Promise.all(takes);
    expect(waits.filter((w) => w === 0)).toHaveLength(5);
    expect(waits.filter((w) => w > 0)).toHaveLength(35);
  });

  it('refills by the clock the caller passes, never above the capacity', async () => {
    const node = open();
    const s = { capacity: 1, refillPerSecond: 1 };
    const key = `refill-${run}`;
    expect(await node.take(key, s, 0)).toBe(0);
    expect(await node.take(key, s, 500)).toBe(500);
    expect(await node.take(key, s, 1000)).toBe(0);
    expect(await node.take(key, s, 60_000)).toBe(0);
    expect(await node.take(key, s, 60_000)).toBeGreaterThan(0);
  });

  it('gives a bucket its full capacity again when its key is lost (counters only)', async () => {
    const node = open();
    const s = { capacity: 1, refillPerSecond: 0.001 };
    const key = `lost-${run}`;
    expect(await node.take(key, s, 0)).toBe(0);
    expect(await node.take(key, s, 0)).toBeGreaterThan(0);
    // A flush or an eviction of this one key: the next take starts from a full bucket.
    await node.raw('DEL', `${prefix}${key}`);
    expect(await node.take(key, s, 0)).toBe(0);
  });
});
