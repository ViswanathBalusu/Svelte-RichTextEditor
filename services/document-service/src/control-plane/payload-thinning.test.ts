// The payload thinning service (HIS-032) over a fake store: which payloads it asks the store to
// delete, and which documents it leaves alone. The PostgreSQL rows are tested in
// test/postgres/his-032-thinning.pg.test.ts.
import { describe, expect, it } from 'vitest';
import { MemoryAudit } from '../data-plane/memory-ports.ts';
import { DAY_MS } from './document-purge.ts';
import {
  PayloadThinning,
  payloadThinningTask,
  type ThinningFacts,
  type ThinningStore,
} from './payload-thinning.ts';
import { MemoryRetentionStore, RetentionService } from './retention.ts';

const T = '11111111-1111-4111-8111-111111111111';
const NOW = Date.UTC(2026, 10, 17);

class FakeStore implements ThinningStore {
  readonly removed: Array<{ doc: string; seqs: number[] }> = [];
  readonly reads: string[] = [];
  readonly #facts: Record<string, ThinningFacts>;
  constructor(facts: Record<string, ThinningFacts>) {
    this.#facts = facts;
  }
  async documents(): Promise<string[]> {
    return Object.keys(this.#facts);
  }
  async facts(_tenant: string, doc: string, before: number): Promise<ThinningFacts> {
    this.reads.push(doc);
    const f = this.#facts[doc]!;
    return { ...f, commits: f.commits.filter((c) => c.time < before) };
  }
  async remove(_tenant: string, doc: string, seqs: readonly number[]): Promise<number> {
    this.removed.push({ doc, seqs: [...seqs] });
    return seqs.length;
  }
}

const old = (seq: number, kind = 'steps') => ({ seq, time: NOW - 40 * DAY_MS, kind });
const fresh = (seq: number) => ({ seq, time: NOW - DAY_MS, kind: 'steps' });

function setup(facts: Record<string, ThinningFacts>) {
  const store = new FakeStore(facts);
  const audit = new MemoryAudit();
  const retention = new RetentionService({
    store: new MemoryRetentionStore(),
    audit,
    documentExists: async () => true,
    now: () => NOW,
  });
  const thinning = new PayloadThinning({ store, retention, audit, now: () => NOW });
  return { store, audit, retention, thinning };
}

describe('payload thinning (HIS-032)', () => {
  it('removes nothing while the policy is the default, keep_all', async () => {
    const { store, thinning } = setup({
      d1: { commits: [old(1), old(2)], checkpoints: [2], versions: [] },
    });
    expect((await thinning.run(T)).thinned).toEqual([]);
    expect(store.removed).toEqual([]);
  });

  it('removes the old payloads below the newest checkpoint, keeps a pinned version and the newer ones', async () => {
    const { store, audit, retention, thinning } = setup({
      d1: {
        commits: [old(1), old(2), old(3), old(4), old(5)],
        checkpoints: [2, 4],
        versions: [{ seq: 3, kind: 'named' }],
      },
    });
    await retention.setTenant(T, 'admin', { mode: 'thin_payloads', afterDays: 30 }, 0);
    const r = await thinning.run(T);
    expect(r.thinned).toEqual([{ doc: 'd1', removed: 3 }]);
    // 3 is kept for the named version, 5 is above the newest checkpoint.
    expect(store.removed).toEqual([{ doc: 'd1', seqs: [1, 2, 4] }]);
    const events = await audit.query(T, { kind: 'history.thinned', limit: 5 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      doc: 'd1',
      actor: 'system',
      data: { removed: 3, keptForVersions: 1, afterDays: 30 },
    });
    expect(JSON.stringify(events[0])).not.toMatch(/payload|steps|text/);
  });

  it('removes nothing for a document with no checkpoint, since a room replays from the start', async () => {
    const { store, retention, thinning } = setup({
      d1: { commits: [old(1), old(2)], checkpoints: [], versions: [] },
    });
    await retention.setTenant(T, 'admin', { mode: 'thin_payloads', afterDays: 30 }, 0);
    expect((await thinning.run(T)).thinned).toEqual([]);
    expect(store.removed).toEqual([]);
  });

  it('keeps the payloads inside the period and the payload of a snapshot commit', async () => {
    const { store, retention, thinning } = setup({
      d1: {
        commits: [old(1), old(2, 'snapshot'), fresh(3), old(4)],
        checkpoints: [4],
        versions: [],
      },
    });
    await retention.setTenant(T, 'admin', { mode: 'thin_payloads', afterDays: 30 }, 0);
    await thinning.run(T);
    expect(store.removed).toEqual([{ doc: 'd1', seqs: [1, 4] }]);
  });

  it('leaves a document under a legal hold alone, without reading it (criterion 5)', async () => {
    const { store, retention, thinning } = setup({
      held: { commits: [old(1), old(2)], checkpoints: [2], versions: [] },
      free: { commits: [old(1), old(2)], checkpoints: [2], versions: [] },
    });
    await retention.setTenant(T, 'admin', { mode: 'thin_payloads', afterDays: 30 }, 0);
    const r = await thinning.run(T, new Set(['held']));
    expect(r.skipped).toEqual([{ doc: 'held', reason: 'legal-hold' }]);
    expect(r.thinned).toEqual([{ doc: 'free', removed: 2 }]);
    expect(store.reads).toEqual(['free']);
    expect(store.removed.map((x) => x.doc)).toEqual(['free']);
  });

  it("honours a document's own policy over the tenant's", async () => {
    const { store, retention, thinning } = setup({
      keep: { commits: [old(1), old(2)], checkpoints: [2], versions: [] },
      short: { commits: [fresh(1), old(2), old(3)], checkpoints: [3], versions: [] },
    });
    await retention.setTenant(T, 'admin', { mode: 'thin_payloads', afterDays: 30 }, 0);
    await retention.setDocument(T, 'keep', 'admin', { mode: 'keep_all' }, 0);
    await retention.setDocument(T, 'short', 'admin', { mode: 'thin_payloads', afterDays: 1 }, 0);
    await thinning.run(T);
    expect(store.removed).toEqual([{ doc: 'short', seqs: [2, 3] }]); // seq 1 is exactly one day old: inside the period
  });

  describe('payloads that have moved to cold segments (HIS-029)', () => {
    /** A remover that records what it is asked to take out, and holds what the segments hold. */
    function remover(held: Record<string, number[]>) {
      const asked: Array<{ doc: string; seqs: number[] }> = [];
      return {
        asked,
        remove: async (_tenant: string, doc: string, seqs: readonly number[]) => {
          asked.push({ doc, seqs: [...seqs] });
          const there = held[doc] ?? [];
          const removed = seqs.filter((s) => there.includes(s));
          held[doc] = there.filter((s) => !seqs.includes(s));
          return { removed, objects: removed.length ? [`segments of ${doc}`] : [] };
        },
      };
    }

    function setupCold(facts: Record<string, ThinningFacts>, held: Record<string, number[]>) {
      const store = new FakeStore(facts);
      const audit = new MemoryAudit();
      const retention = new RetentionService({
        store: new MemoryRetentionStore(),
        audit,
        documentExists: async () => true,
        now: () => NOW,
      });
      const cold = remover(held);
      const thinning = new PayloadThinning({ store, retention, audit, now: () => NOW, cold });
      return { store, audit, retention, thinning, cold };
    }

    it('removes them from their segment by the same plan as the payloads in the table', async () => {
      // Seq 1 to 4 are in one segment, 5 and 6 in the table; a named version at 3, checkpoints at 2
      // and 6.
      const { store, audit, retention, thinning, cold } = setupCold(
        {
          d1: {
            commits: [old(5), old(6)],
            checkpoints: [2, 6],
            versions: [{ seq: 3, kind: 'named' }],
            cold: [
              {
                fromSeq: 1,
                toSeq: 4,
                payloads: 4,
                tombstoned: 0,
                commits: [old(1), old(2), old(3), old(4)],
              },
            ],
          },
        },
        { d1: [1, 2, 3, 4] },
      );
      await retention.setTenant(T, 'admin', { mode: 'thin_payloads', afterDays: 30 }, 0);
      const r = await thinning.run(T);
      // 3 is kept for the named version; 1, 2 and 4 leave the segment, 5 and 6 the table.
      expect(cold.asked).toEqual([{ doc: 'd1', seqs: [1, 2, 4] }]);
      expect(store.removed).toEqual([{ doc: 'd1', seqs: [5, 6] }]);
      expect(r.thinned).toEqual([{ doc: 'd1', removed: 5 }]);
      const events = await audit.query(T, { kind: 'history.thinned', limit: 5 });
      expect(events[0]).toMatchObject({
        data: { removed: 5, fromSegments: 3, keptForVersions: 1, afterDays: 30 },
      });
    });

    it('does not open a segment that holds no more than the plan keeps', async () => {
      // The segment of 1 to 4 was thinned by an earlier run: it holds the one payload the named
      // version needs. The segment of 5 to 8 lost one payload to a tombstone and was never thinned.
      const { retention, thinning, cold } = setupCold(
        {
          d1: {
            commits: [],
            checkpoints: [2, 8],
            versions: [{ seq: 3, kind: 'named' }],
            cold: [
              {
                fromSeq: 1,
                toSeq: 4,
                payloads: 1,
                tombstoned: 0,
                commits: [old(1), old(2), old(3), old(4)],
              },
              {
                fromSeq: 5,
                toSeq: 8,
                payloads: 3,
                tombstoned: 1,
                commits: [old(5), old(6), old(8)],
              },
            ],
          },
        },
        { d1: [3, 5, 6, 8] },
      );
      await retention.setTenant(T, 'admin', { mode: 'thin_payloads', afterDays: 30 }, 0);
      const r = await thinning.run(T);
      expect(cold.asked).toEqual([{ doc: 'd1', seqs: [5, 6, 8] }]);
      expect(r.thinned).toEqual([{ doc: 'd1', removed: 3 }]);
      // A second run with what the segments hold now asks for nothing.
      cold.asked.length = 0;
      const again = setupCold(
        {
          d1: {
            commits: [],
            checkpoints: [2, 8],
            versions: [{ seq: 3, kind: 'named' }],
            cold: [
              {
                fromSeq: 1,
                toSeq: 4,
                payloads: 1,
                tombstoned: 0,
                commits: [old(1), old(2), old(3), old(4)],
              },
            ],
          },
        },
        { d1: [3] },
      );
      await again.retention.setTenant(T, 'admin', { mode: 'thin_payloads', afterDays: 30 }, 0);
      expect((await again.thinning.run(T)).thinned).toEqual([]);
      expect(again.cold.asked).toEqual([]);
      expect(await again.audit.query(T, { kind: 'history.thinned', limit: 5 })).toEqual([]);
    });

    it('keeps the payloads of a segment that are inside the period, and those above the newest checkpoint', async () => {
      // The store lists only the commits older than the cut: seq 1 and 2 of a segment of 1 to 4.
      const { retention, thinning, cold } = setupCold(
        {
          d1: {
            commits: [],
            checkpoints: [4],
            versions: [],
            cold: [{ fromSeq: 1, toSeq: 4, payloads: 4, tombstoned: 0, commits: [old(1), old(2)] }],
          },
          d2: {
            commits: [],
            checkpoints: [1],
            versions: [],
            cold: [{ fromSeq: 1, toSeq: 2, payloads: 2, tombstoned: 0, commits: [old(1), old(2)] }],
          },
        },
        { d1: [1, 2, 3, 4], d2: [1, 2] },
      );
      await retention.setTenant(T, 'admin', { mode: 'thin_payloads', afterDays: 30 }, 0);
      await thinning.run(T);
      expect(cold.asked).toEqual([
        { doc: 'd1', seqs: [1, 2] },
        { doc: 'd2', seqs: [1] },
      ]);
    });

    it('leaves the segments alone under a legal hold, and when no remover is given', async () => {
      const facts: Record<string, ThinningFacts> = {
        d1: {
          commits: [],
          checkpoints: [2],
          versions: [],
          cold: [{ fromSeq: 1, toSeq: 2, payloads: 2, tombstoned: 0, commits: [old(1), old(2)] }],
        },
      };
      const held = setupCold(facts, { d1: [1, 2] });
      await held.retention.setTenant(T, 'admin', { mode: 'thin_payloads', afterDays: 30 }, 0);
      expect((await held.thinning.run(T, new Set(['d1']))).skipped).toEqual([
        { doc: 'd1', reason: 'legal-hold' },
      ]);
      expect(held.cold.asked).toEqual([]);
      // Without a remover the payloads that have moved stay where they are.
      const plain = setup(facts);
      await plain.retention.setTenant(T, 'admin', { mode: 'thin_payloads', afterDays: 30 }, 0);
      expect((await plain.thinning.run(T)).thinned).toEqual([]);
      expect(plain.store.removed).toEqual([]);
    });
  });

  it('is a daily task that deletes data, so the scheduler hands it the held documents', async () => {
    const { retention, thinning, store } = setup({
      d1: { commits: [old(1)], checkpoints: [1], versions: [] },
    });
    await retention.setTenant(T, 'admin', { mode: 'thin_payloads', afterDays: 30 }, 0);
    const task = payloadThinningTask(thinning);
    expect(task).toMatchObject({ name: 'payloads.thin', everyMs: DAY_MS, deletes: true });
    expect(await task.forTenant!(T, NOW, { held: new Set(['d1']) })).toBe(0);
    expect(store.removed).toEqual([]);
    expect(await task.forTenant!(T, NOW, { held: new Set() })).toBe(1);
  });
});
