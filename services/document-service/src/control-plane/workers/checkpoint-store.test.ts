// BE-001 criterion 3, the content a document is created with: its serialisation (canonical text and
// Zstandard) runs in the worker pool when the content is large, gives the bytes the main thread
// would have given, and fails with `internal` when the worker is lost. Small content never waits
// for a worker.
import { randomUUID } from 'node:crypto';
import { threadId } from 'node:worker_threads';
import type { JsonEnvelope } from '@docedit/model';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectCheckpointStore, encodeCheckpoint } from '../../objects/checkpoints.ts';
import { MemoryObjectStore } from '../../objects/store.ts';
import type { CheckpointStore, DocRef } from '../../storage/types.ts';
import {
  SERIALISE_IN_POOL_FROM,
  holdsAtLeast,
  serialisedInPool,
  type Serialised,
} from './checkpoint-store.ts';
import { WorkerPool } from './pool.ts';

const paragraph = (id: string, text: string) => ({
  type: 'paragraph',
  attrs: { id, style: 'Normal' },
  content: [{ type: 'text', text }],
});
/** An envelope with `paragraphs` paragraphs of `text`. Nothing here validates it: it is only stored. */
const envelope = (paragraphs: number, text: string): JsonEnvelope =>
  ({
    cdm: 1,
    requires: [],
    doc: {
      type: 'doc',
      content: [
        {
          type: 'body',
          content: Array.from({ length: paragraphs }, (_, i) =>
            paragraph(`p${String(i).padStart(15, '0')}`, text),
          ),
        },
      ],
    },
  }) as unknown as JsonEnvelope;

/** The characters of every string and member name: what `holdsAtLeast` counts. */
function countChars(v: unknown): number {
  if (typeof v === 'string') return v.length;
  if (Array.isArray(v)) return v.reduce<number>((a, x) => a + countChars(x), 0);
  if (v !== null && typeof v === 'object')
    return Object.entries(v).reduce((a, [k, x]) => a + k.length + countChars(x), 0);
  return 0;
}

describe('holdsAtLeast', () => {
  it('agrees with a full count of the strings and member names', () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.integer({ min: 0, max: 200 }), (value, limit) => {
        expect(holdsAtLeast(value, limit)).toBe(countChars(value) >= limit);
      }),
    );
  });

  it('stops walking once the limit is reached', () => {
    let read = 0;
    const counted = (text: string) => ({
      get text() {
        read++;
        return text;
      },
    });
    const items = Array.from({ length: 1000 }, () => counted('x'.repeat(100)));
    expect(holdsAtLeast(items, 1000)).toBe(true);
    // 104 characters an item (`text` and its value): the tenth item reaches 1,000.
    expect(read).toBe(10);
  });

  it('counts nothing for numbers, booleans and null', () => {
    expect(holdsAtLeast([1, 2.5, true, false, null], 1)).toBe(false);
    expect(holdsAtLeast({ a: 1 }, 1)).toBe(true);
    expect(holdsAtLeast(null, 0)).toBe(true);
  });
});

describe('the content at seq 0 is serialised in the worker pool (BE-001 criterion 3)', () => {
  let pool: WorkerPool;
  let tasks: Array<{ kind: string; thread: number | null }>;
  /** The pool as the store sees it: every task is noted with the thread that answered it. */
  const recording = {
    run: async <T>(kind: string, input: unknown): Promise<T> => {
      const out = await pool.run<T>(kind, input);
      tasks.push({ kind, thread: (out as { threadId?: number } | null)?.threadId ?? null });
      return out;
    },
  };
  const ref = (): DocRef => ({ tenant: randomUUID(), doc: randomUUID() });
  const stores = () => {
    const objects = new ObjectCheckpointStore(new MemoryObjectStore());
    return { objects, store: serialisedInPool(objects, recording) };
  };
  const large = envelope(400, 'The quick brown fox jumps over the lazy dog. '.repeat(10));
  const small = envelope(3, 'Hello');

  beforeAll(() => {
    pool = new WorkerPool({ size: 1, taskTimeoutMs: 60_000 });
  });
  afterAll(async () => {
    await pool.close();
  });

  it('serialises large content in a thread other than the main one, to the same bytes', async () => {
    tasks = [];
    expect(holdsAtLeast(large, SERIALISE_IN_POOL_FROM)).toBe(true);
    const { objects, store } = stores();
    const r = ref();
    await store.put(r, 0, large);
    expect(tasks.map((t) => t.kind)).toEqual(['serialise']);
    expect(tasks[0]!.thread).not.toBeNull();
    expect(tasks[0]!.thread).not.toBe(threadId);
    // Byte for byte what the main thread would have stored, so readers cannot tell.
    const stored = await objects.getEncoded(r, 0);
    expect(Buffer.from(stored!).equals(Buffer.from(encodeCheckpoint(large)))).toBe(true);
    expect(await store.get(r, 0)).toEqual(large);
    expect((await store.latest(r, 5))?.seq).toBe(0);
  });

  it('serialises small content in the request, with no task', async () => {
    tasks = [];
    expect(holdsAtLeast(small, SERIALISE_IN_POOL_FROM)).toBe(false);
    const { objects, store } = stores();
    const r = ref();
    await store.put(r, 0, small);
    expect(tasks).toEqual([]);
    const stored = await objects.getEncoded(r, 0);
    expect(Buffer.from(stored!).equals(Buffer.from(encodeCheckpoint(small)))).toBe(true);
  });

  it('sends everything to the pool when the threshold is 0', async () => {
    tasks = [];
    const objects = new ObjectCheckpointStore(new MemoryObjectStore());
    const store = serialisedInPool(objects, recording, 0);
    const r = ref();
    await store.put(r, 0, small);
    expect(tasks.map((t) => t.kind)).toEqual(['serialise']);
    expect(await store.get(r, 0)).toEqual(small);
  });

  it('gives the same bytes as the main thread for any JSON content', async () => {
    await fc.assert(
      fc.asyncProperty(fc.jsonValue(), async (doc) => {
        const content = { cdm: 1, requires: [], doc } as unknown as JsonEnvelope;
        const { bytes } = await pool.run<Serialised>('serialise', { content });
        expect(Buffer.from(bytes).equals(Buffer.from(encodeCheckpoint(content)))).toBe(true);
      }),
      { numRuns: 40 },
    );
  });

  it('passes encoded bytes, reads and side objects through unchanged', async () => {
    tasks = [];
    const { objects, store } = stores();
    const r = ref();
    const bytes = encodeCheckpoint(small);
    await store.putEncoded!(r, 4, bytes);
    expect(Buffer.from((await store.getEncoded!(r, 4))!).equals(Buffer.from(bytes))).toBe(true);
    await store.putSide!(r, 4, new Uint8Array([1, 2, 3]));
    expect([...(await objects.getSide(r, 4))!]).toEqual([1, 2, 3]);
    expect([...(await store.getSide!(r, 4))!]).toEqual([1, 2, 3]);
    expect(await store.setAside!(r, 0)).toEqual([4]);
    expect(await store.get(r, 4)).toBeNull();
    expect(tasks).toEqual([]);
  });

  it('returns a store that takes no encoded bytes as it is', () => {
    const plain: CheckpointStore = {
      put: async () => undefined,
      get: async () => null,
      latest: async () => null,
    };
    expect(serialisedInPool(plain, recording)).toBe(plain);
  });

  it('fails the write with the retryable code internal when the worker is lost, and stores nothing', async () => {
    // A task that runs past its time limit ends its worker (pool.ts); 1 ms is over before it starts.
    const doomed = new WorkerPool({ size: 1, taskTimeoutMs: 1 });
    try {
      const objects = new ObjectCheckpointStore(new MemoryObjectStore());
      const store = serialisedInPool(objects, doomed);
      const r = ref();
      await expect(store.put(r, 0, large)).rejects.toMatchObject({ code: 'internal' });
      expect(await objects.getEncoded(r, 0)).toBeNull();
      expect(doomed.replaced).toBeGreaterThanOrEqual(1);
    } finally {
      await doomed.close();
    }
  });
});
