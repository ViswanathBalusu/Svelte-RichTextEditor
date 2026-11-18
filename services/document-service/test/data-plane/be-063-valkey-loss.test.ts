// Redis or Valkey holds counters and the bus, never data of record (BE-063 criterion 3). Two
// things are shown. First, what the service writes to Valkey: only the modules that name the
// counters and the bus touch it. Second, a flush of the whole server while a data plane runs
// loses no commit, grant, lease or owner, because none is stored there. The second part runs
// against a real Valkey when `DOCEDIT_VALKEY_URL` names one (for example `redis://127.0.0.1:56375`).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { uuid7 } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { ValkeyBus } from '../../src/data-plane/valkey-bus.ts';
import { RateLimits } from '../../src/data-plane/limits.ts';
import { MemoryNodeLeases } from '../../src/data-plane/memory-ports.ts';
import { DEFAULT_RATES } from '../../src/data-plane/settings.ts';
import {
  parseValkeyUrl,
  ValkeyClient,
  ValkeyTokenBuckets,
} from '../../src/data-plane/valkey-buckets.ts';
import { MemoryStore } from '../../src/storage/memory.ts';
import { insertText } from './client.ts';
import { startPlane, type Plane } from './support.ts';

const liveUrl = process.env['DOCEDIT_VALKEY_URL'];
const intro = () => posInside(baseDoc(), 'pIntro0000000001');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [p] : [];
  });
}

describe('what the service keeps in Valkey (BE-063 criterion 3)', () => {
  it('is reached only through the counters and the bus', () => {
    const root = join(import.meta.dirname, '../../src');
    const users = sources(root)
      .filter((f) =>
        /valkey-buckets|valkey-bus|ValkeyClient|ValkeyTokenBuckets|ValkeyBus/.test(
          readFileSync(f, 'utf8'),
        ),
      )
      .map((f) => f.slice(root.length + 1).replace(/\\/g, '/'))
      .sort();
    // The composition (server.ts) builds the counters from configuration; the stores of record
    // (storage/, data-plane/pg/, data-plane/memory-ports.ts) never name Valkey.
    expect(users.filter((f) => /^storage\/|\/pg\/|memory-ports/.test(f))).toEqual([]);
    expect(users).toEqual(
      expect.arrayContaining(['data-plane/valkey-buckets.ts', 'data-plane/valkey-bus.ts']),
    );
  });
});

describe.skipIf(liveUrl === undefined)(
  'a flushed Valkey loses no data of record (BE-063 criterion 3)',
  () => {
    let planes: Plane[] = [];
    const closers: Array<() => void | Promise<void>> = [];
    afterEach(async () => {
      for (const p of planes) await p.close();
      planes = [];
      for (const c of closers.splice(0)) await c();
    });

    it('keeps the commits, the lease and the owner of a running node when the server is flushed', async () => {
      const run = uuid7();
      const buckets = new ValkeyTokenBuckets({
        url: liveUrl!,
        prefix: `docedit:rl:w5-be063:${run}:`,
      });
      const bus = new ValkeyBus({
        node: 'node-a',
        url: liveUrl!,
        prefix: `docedit:bus:w5-be063:${run}:`,
      });
      const admin = new ValkeyClient(parseValkeyUrl(liveUrl!), 2000);
      closers.push(
        () => buckets.close(),
        () => bus.close(),
        () => admin.close(),
      );
      const mem = new MemoryStore();
      const leases = new MemoryNodeLeases();
      const p = await startPlane({
        stores: { logs: mem, ownership: mem, grants: mem, documents: mem },
        node: 'node-a',
        deps: {
          leases,
          limits: new RateLimits(
            { ...DEFAULT_RATES, connection: { capacity: 1000, refillPerSecond: 1000 } },
            { store: buckets },
          ),
        },
        settings: { lease: { durationMs: 2000, renewMs: 200, marginMs: 100 } },
      });
      planes.push(p);
      expect(await p.plane.ready()).toBe(true);
      const doc = await p.createDocument();
      const alice = await p.client('alice', { [doc]: 'owner' });
      expect((await alice.open(1, doc)).t).toBe('ch.opened');
      expect((await alice.submit(1, { base: 0, steps: [insertText(intro(), 'one')] })).t).toBe(
        'sync.ack',
      );
      expect(buckets.stats.shared).toBeGreaterThan(0);
      await bus.publish('t', 'announcement');
      const before = await mem.head(p.ref(doc));
      expect(before).toMatchObject({ seq: 1, owner: 'node-a' });

      // Every key of the server goes: the counters, the streams of the bus, whatever else.
      await admin.command('FLUSHALL');

      // The node goes on: the room is open, the next commit is acknowledged and stored, the lease is
      // renewed and the owner and its epoch are as they were.
      expect((await alice.submit(1, { base: 1, steps: [insertText(intro(), 'two')] })).t).toBe(
        'sync.ack',
      );
      await new Promise((r) => setTimeout(r, 500));
      const after = await mem.head(p.ref(doc));
      expect(after).toMatchObject({ seq: 2, owner: 'node-a', epoch: before.epoch });
      expect(await leases.alive('node-a')).toBe(true);
      expect(p.plane.lease?.proven).toBe(true);
      const log = await mem.read(p.ref(doc), 1);
      expect(log.map((c) => c.seq)).toEqual([1, 2]);
      expect(p.errors).toEqual([]);
    });
  },
);
