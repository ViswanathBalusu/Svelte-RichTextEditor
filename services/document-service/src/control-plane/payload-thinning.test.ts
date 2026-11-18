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
