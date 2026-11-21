// BE-001 criterion 3, the side object of a checkpoint (06 §2.2 step 3: the attribution map and the
// comment ranges): it is serialised by a task of the data plane's pool, like the content, and the
// stored bytes are those the main thread would have written. A failure of the task is reported and
// does not fail the checkpoint.
import { randomUUID } from 'node:crypto';
import { threadId } from 'node:worker_threads';
import type { ThreadAnchor } from '@docedit/authority';
import type { AttributionJson } from '@docedit/history';
import type { JsonEnvelope } from '@docedit/model';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectCheckpointStore } from '../objects/checkpoints.ts';
import { MemoryObjectStore } from '../objects/store.ts';
import { decodeSide, encodeSide, type CheckpointSide } from '../storage/codec.ts';
import type { DocRef } from '../storage/types.ts';
import { Checkpointer } from './checkpoints.ts';
import { encode, runTask } from './tasks.ts';
import { Workers } from './workers.ts';

const envelope = {
  cdm: 1,
  requires: [],
  doc: { type: 'doc', content: [{ type: 'body', content: [] }] },
} as unknown as JsonEnvelope;
const attribution: AttributionJson = {
  v: 1,
  authors: [
    ['u-ann', 0, null, null, null],
    ['u-ben', 7, 'assistant', null, null],
    ['u-cay', 9, null, 'u-ann', 4],
  ],
  runs: [12, 0, 5, 1, 30, 2, 2, 0],
};
const threads: ThreadAnchor[] = [
  { id: 't1', author: 'u-ann', target: { range: { from: 3, to: 9 } }, seq: 9, detached: false },
  {
    id: 't2',
    author: 'u-ben',
    target: { block: 'pIntro0000000001' },
    seq: 9,
    detached: true,
    scopes: ['body'],
  },
];
const same = (a: Uint8Array | null, b: Uint8Array) =>
  a !== null && Buffer.from(a).equals(Buffer.from(b));

const author = fc.tuple(
  fc.string(),
  fc.nat(),
  fc.option(fc.string(), { nil: null }),
  fc.option(fc.string(), { nil: null }),
  fc.option(fc.nat(), { nil: null }),
);
const sides: fc.Arbitrary<CheckpointSide> = fc.record({
  v: fc.constant(1 as const),
  seq: fc.nat(),
  threads: fc.array(
    fc.record({
      id: fc.string(),
      author: fc.string(),
      target: fc.oneof(
        fc.record({ range: fc.record({ from: fc.nat(), to: fc.nat() }) }),
        fc.record({ block: fc.string() }),
      ),
      seq: fc.nat(),
      detached: fc.boolean(),
    }),
    { maxLength: 5 },
  ),
  attribution: fc.record({
    v: fc.constant(1 as const),
    authors: fc.array(author, { maxLength: 8 }),
    runs: fc.array(fc.nat(), { maxLength: 16 }),
  }),
});

describe('the side object of a checkpoint is serialised in a worker thread (BE-001 criterion 3)', () => {
  let workers: Workers;
  const ref = (): DocRef => ({ tenant: randomUUID(), doc: randomUUID() });
  const errors: unknown[] = [];
  const checkpointer = (
    pool: Workers,
    store = new ObjectCheckpointStore(new MemoryObjectStore()),
  ) => ({
    store,
    cp: new Checkpointer({
      store,
      index: undefined,
      workers: pool,
      onSavedError: (e) => errors.push(e),
    }),
  });

  beforeAll(() => {
    workers = new Workers({ size: 1, timeoutMs: 60_000 });
  });
  afterAll(async () => {
    await workers.close();
  });

  it('runs the task in a thread other than the main one', async () => {
    expect((await workers.run('thread', null)).threadId).not.toBe(threadId);
  });

  it('stores the bytes the main thread would have written, from one task and none inline', async () => {
    const { store, cp } = checkpointer(workers);
    const r = ref();
    const before = { ...workers.stats };
    await cp.save(r, 9, encode({ envelope }), false, attribution, threads);
    expect(workers.stats.run - before.run).toBe(1);
    expect(workers.stats.inline).toBe(before.inline);
    expect(
      same(await store.getSide(r, 9), encodeSide({ v: 1, seq: 9, threads, attribution })),
    ).toBe(true);
    // What a room that opens reads back: the map, and the ranges at the checkpoint's seq.
    expect(await cp.loadSide(r, 9)).toEqual(attribution);
    expect((await cp.load(r, 9))?.threads).toEqual(threads);
    expect(errors).toEqual([]);
  });

  it('writes no side object, and sends no task, for a checkpoint with neither a map nor ranges', async () => {
    const { store, cp } = checkpointer(workers);
    const r = ref();
    const before = { ...workers.stats };
    await cp.save(r, 3, encode({ envelope }), false, undefined, []);
    expect(workers.stats.run).toBe(before.run);
    expect(await store.getSide(r, 3)).toBeNull();
    expect(await store.getEncoded(r, 3)).not.toBeNull();
  });

  it('gives the same bytes in the worker, inline and on the main thread for any side object', async () => {
    await fc.assert(
      fc.asyncProperty(sides, async (side) => {
        const expected = encodeSide(side);
        expect(same((await workers.run('side', { side })).encoded, expected)).toBe(true);
        expect(same(runTask('side', { side }, 0).encoded, expected)).toBe(true);
        expect(decodeSide(expected)).toEqual(side);
      }),
      { numRuns: 40 },
    );
  });

  it('serialises inline when the pool has no threads (the command-line tools)', async () => {
    const inline = new Workers({ size: 0, timeoutMs: 60_000 });
    try {
      const { store, cp } = checkpointer(inline);
      const r = ref();
      await cp.save(r, 2, encode({ envelope }), false, attribution);
      expect(inline.stats.inline).toBe(1);
      expect(
        same(await store.getSide(r, 2), encodeSide({ v: 1, seq: 2, threads: [], attribution })),
      ).toBe(true);
    } finally {
      await inline.close();
    }
  });

  it('reports a side object that could not be serialised and still stores the checkpoint', async () => {
    // A task that runs past its time limit ends its worker (workers.ts); 1 ms is over before it starts.
    const doomed = new Workers({ size: 1, timeoutMs: 1 });
    errors.length = 0;
    try {
      const { store, cp } = checkpointer(doomed);
      const r = ref();
      const written = await cp.save(r, 5, encode({ envelope }), false, attribution, threads);
      expect(written.seq).toBe(5);
      expect(await store.getEncoded(r, 5)).not.toBeNull();
      expect(await store.getSide(r, 5)).toBeNull();
      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).name).toBe('WorkerTaskError');
    } finally {
      await doomed.close();
      errors.length = 0;
    }
  });
});
