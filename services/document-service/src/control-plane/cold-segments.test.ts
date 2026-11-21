// The cold-segment service (HIS-029) over a fake store with transactions and a real in-memory
// object store: which payloads it moves and where, that a payload leaves the table only after its
// segment read back, what a failure at each step leaves behind, how the next run clears it, and how
// payloads are taken out of a segment afterwards. The PostgreSQL rows, the scheduler and the reads
// over HTTP are tested in test/postgres/his-029-cold-segments.pg.test.ts.
import { webcrypto } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';
import type { LogCommit } from '@docedit/authority';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MemoryAudit } from '../data-plane/memory-ports.ts';
import { MemoryObjectStore, objectKeys, type ObjectStore } from '../objects/store.ts';
import { encodeCommit } from '../storage/codec.ts';
import { ColdSegmentUnavailableError, ObjectColdPayloads } from '../storage/cold-payloads.ts';
import { DocumentKeyDestroyedError, DocumentSealer } from '../storage/document-keys.ts';
import {
  ColdSegments,
  coldSegmentsTask,
  type ColdCandidateRow,
  type ColdFacts,
  type ColdSegmentRow,
  type ColdSegmentStore,
  type ColdTx,
} from './cold-segments.ts';
import { DAY_MS } from './document-purge.ts';

const T = '11111111-1111-4111-8111-111111111111';
const D1 = '22222222-2222-4222-8222-222222222221';
const D2 = '22222222-2222-4222-8222-222222222222';
const NOW = Date.UTC(2026, 10, 20, 12);
const OLD = NOW - 40 * DAY_MS;
const RECENT = NOW - DAY_MS;

interface FakeDoc {
  /** Payload rows as the table holds them: Zstandard-compressed canonical JSON. */
  payloads: Map<number, Uint8Array>;
  /** The metadata of every commit. */
  commits: Map<number, { time: number; hash: string; size: number; json: unknown }>;
  checkpoint: number | null;
  rows: Map<number, ColdSegmentRow>;
}

type Fault = 'deletePayloads' | 'setMoved' | 'commit' | 'answer-lost';

/** A store in memory: `locked` runs one callback at a time for a document and rolls back on a throw. */
class FakeStore implements ColdSegmentStore {
  readonly docs = new Map<string, FakeDoc>();
  /** A fault for the next transaction that reaches the step, cleared when it fires. */
  fault: Fault | null = null;
  /** How many transactions ran. */
  transactions = 0;
  readonly #queues = new Map<string, Promise<unknown>>();

  add(doc: string, times: readonly number[], checkpoint: number | null): FakeDoc {
    const d: FakeDoc = { payloads: new Map(), commits: new Map(), checkpoint, rows: new Map() };
    times.forEach((time, i) => {
      const seq = i + 1;
      const e = encodeCommit(doc, commitOf(seq, time));
      d.payloads.set(seq, new Uint8Array(e.payload));
      d.commits.set(seq, {
        time,
        hash: e.payloadHash.toString('hex'),
        size: e.meta.size,
        json: JSON.parse(zstdDecompressSync(e.payload).toString('utf8')),
      });
    });
    this.docs.set(doc, d);
    return d;
  }

  async documents(): Promise<string[]> {
    return [...this.docs.keys()];
  }

  async pending(): Promise<Array<{ doc: string; fromSeq: number }>> {
    const out: Array<{ doc: string; fromSeq: number }> = [];
    for (const [doc, d] of this.docs)
      for (const row of d.rows.values())
        if (row.state === 'pending') out.push({ doc, fromSeq: row.fromSeq });
    return out;
  }

  async facts(_tenant: string, doc: string, before: number, limit: number): Promise<ColdFacts> {
    const d = this.docs.get(doc)!;
    if (d.checkpoint === null) return { newestCheckpoint: null, candidates: [] };
    const candidates: ColdCandidateRow[] = [...d.payloads.keys()]
      .sort((a, b) => a - b)
      .filter((seq) => seq <= d.checkpoint! && d.commits.get(seq)!.time < before)
      .slice(0, limit)
      .map((seq) => {
        const c = d.commits.get(seq)!;
        return { seq, time: c.time, payloadHash: c.hash, size: c.size };
      });
    return { newestCheckpoint: d.checkpoint, candidates };
  }

  locked<T>(_tenant: string, doc: string, fn: (tx: ColdTx) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      this.transactions++;
      const d = this.docs.get(doc)!;
      const before = {
        payloads: new Map(d.payloads),
        rows: new Map([...d.rows].map(([k, v]) => [k, { ...v }] as const)),
      };
      const rollback = () => {
        d.payloads = before.payloads;
        d.rows = before.rows;
      };
      const take = (f: Fault): boolean => {
        if (this.fault !== f) return false;
        this.fault = null;
        return true;
      };
      // The faults of the commit are those of the transaction that moves: the one that set `moved`.
      let moving = false;
      const tx: ColdTx = {
        row: async (fromSeq) => {
          const r = d.rows.get(fromSeq);
          return r ? { ...r } : null;
        },
        moved: async (fromSeq, toSeq) =>
          [...d.rows.values()]
            .filter((r) => r.state === 'moved' && r.toSeq >= fromSeq && r.fromSeq <= toSeq)
            .sort((a, b) => a.fromSeq - b.fromSeq)
            .map((r) => ({ ...r })),
        insertPending: async (s) => {
          for (const r of d.rows.values())
            if (r.toSeq >= s.fromSeq && r.fromSeq <= s.toSeq) return false;
          d.rows.set(s.fromSeq, { ...s, state: 'pending', payloads: 0 });
          return true;
        },
        payloads: async (seqs) => {
          const out = new Map<number, Uint8Array>();
          for (const seq of seqs) {
            const p = d.payloads.get(seq);
            if (p) out.set(seq, p);
          }
          return out;
        },
        deletePayloads: async (seqs) => {
          if (take('deletePayloads')) throw new Error('the delete was refused');
          if (seqs.some((seq) => !d.payloads.has(seq)))
            throw new Error('a payload row was gone already');
          for (const seq of seqs) d.payloads.delete(seq);
        },
        setMoved: async (fromSeq, payloads) => {
          if (take('setMoved')) throw new Error('the update was refused');
          const r = d.rows.get(fromSeq);
          if (!r || r.state !== 'pending') throw new Error('the pending row of the move is gone');
          r.state = 'moved';
          r.payloads = payloads;
          moving = true;
        },
        setPending: async (fromSeq) => {
          const r = d.rows.get(fromSeq)!;
          r.state = 'pending';
          r.payloads = 0;
        },
        setPayloads: async (fromSeq, payloads) => {
          d.rows.get(fromSeq)!.payloads = payloads;
        },
        deleteRow: async (fromSeq) => {
          d.rows.delete(fromSeq);
        },
      };
      try {
        const result = await fn(tx);
        if (moving && take('commit')) throw new Error('the transaction could not be committed');
        // The transaction committed and the answer never reached the caller.
        if (moving && take('answer-lost')) {
          const lost = new Error('the connection was lost');
          Object.assign(lost, { committed: true });
          throw lost;
        }
        return result;
      } catch (e) {
        if (!(e as { committed?: boolean }).committed) rollback();
        throw e;
      }
    };
    const queued = (this.#queues.get(doc) ?? Promise.resolve()).then(run, run);
    this.#queues.set(
      doc,
      queued.catch(() => undefined),
    );
    return queued;
  }
}

function commitOf(seq: number, time: number): LogCommit {
  return {
    seq,
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    kind: 'steps',
    steps: [
      {
        stepType: 'replace',
        from: 1,
        to: 1,
        slice: { content: [{ type: 'text', text: `text of commit ${seq}` }] },
      },
    ] as never,
    user: 'u1',
    session: 's1',
    time,
    origin: 'input',
    scopes: ['body'],
    revision: 1,
    cdm: 1,
    engine: 'pm-steps/1',
    retired: [],
    claimed: [],
  };
}

interface Setup {
  store: FakeStore;
  objects: MemoryObjectStore;
  audit: MemoryAudit;
  cold: ColdSegments;
  reader: ObjectColdPayloads;
}

function setup(
  over: Partial<ConstructorParameters<typeof ColdSegments>[0]> = {},
  wrap: (o: MemoryObjectStore) => ObjectStore = (o) => o,
): Setup {
  const store = new FakeStore();
  const objects = new MemoryObjectStore();
  const audit = new MemoryAudit();
  const cold = new ColdSegments({
    store,
    objects: wrap(objects),
    audit,
    now: () => NOW,
    ...over,
  });
  return { store, objects, audit, cold, reader: new ObjectColdPayloads(objects) };
}

/** The payloads of every commit of a document, from the table and from its moved segments. */
async function readAll(s: Setup, doc: string): Promise<Map<number, unknown>> {
  const d = s.store.docs.get(doc)!;
  const out = new Map<number, unknown>();
  const wanted = new Map<number, string>();
  for (const [seq, c] of d.commits) {
    const hot = d.payloads.get(seq);
    if (hot) out.set(seq, JSON.parse(zstdDecompressSync(hot).toString('utf8')));
    else wanted.set(seq, c.hash);
  }
  const index = [...d.rows.values()].filter((r) => r.state === 'moved');
  for (const [seq, p] of await s.reader.read({ tenant: T, doc }, wanted, index)) out.set(seq, p);
  return out;
}

/** What every commit's payload was when it was written. */
const written = (s: Setup, doc: string) =>
  new Map([...s.store.docs.get(doc)!.commits].map(([seq, c]) => [seq, c.json] as const));

const segmentKeys = (s: Setup, doc: string) =>
  s.objects.list(`${objectKeys.prefix(T)}docs/${doc}/segments/`);

describe('moving old payloads to cold segments (HIS-029)', () => {
  it('moves the payloads older than 30 days that lie at or below the newest checkpoint, and keeps the rest', async () => {
    const s = setup();
    // Seq 1 to 4 are old, 5 and 6 recent; the newest checkpoint is at 3.
    s.store.add(D1, [OLD, OLD + 1, OLD + 2, OLD + 3, RECENT, RECENT + 1], 3);
    const before = written(s, D1);

    const r = await s.cold.run(T);
    expect(r.failed).toEqual([]);
    expect(r.moved).toMatchObject([{ doc: D1, segments: 1, payloads: 3, held: false }]);
    const d = s.store.docs.get(D1)!;
    // Seq 4 is old but above the checkpoint: a room would replay it, so it stays.
    expect([...d.payloads.keys()]).toEqual([4, 5, 6]);
    expect([...d.rows.values()]).toEqual([
      {
        fromSeq: 1,
        toSeq: 3,
        objectKey: `tenants/${T}/docs/${D1}/segments/1-3.payloads.zst`,
        state: 'moved',
        payloads: 3,
      },
    ]);
    expect(await segmentKeys(s, D1)).toEqual([`tenants/${T}/docs/${D1}/segments/1-3.payloads.zst`]);
    // The object is Zstandard-compressed canonical JSON with one entry per payload and its hash.
    const object = await s.objects.get(d.rows.get(1)!.objectKey);
    const segment = JSON.parse(zstdDecompressSync(object!).toString('utf8')) as {
      format: string;
      entries: Array<{ seq: number; payloadHash: string; payload: unknown }>;
    };
    expect(segment.format).toBe('docedit-payload-segment/1');
    expect(segment.entries.map((e) => [e.seq, e.payloadHash])).toEqual(
      [1, 2, 3].map((seq) => [seq, d.commits.get(seq)!.hash]),
    );
    // Both stores together read what was written.
    expect(await readAll(s, D1)).toEqual(before);

    const events = await s.audit.query(T, { kind: 'history.moved', limit: 5 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      doc: D1,
      actor: 'system',
      data: { segments: 1, payloads: 3, held: false, afterDays: 30 },
    });
    expect(JSON.stringify(events[0])).not.toContain('text of commit');

    // A second run has nothing to do.
    const again = await s.cold.run(T);
    expect(again).toEqual({ moved: [], skipped: [], failed: [], cleared: 0 });
    expect(await s.audit.query(T, { kind: 'history.moved', limit: 5 })).toHaveLength(1);
  });

  it('moves nothing of a document that has no checkpoint above 0, or nothing old', async () => {
    const s = setup();
    s.store.add(D1, [OLD, OLD + 1], null);
    s.store.add(D2, [RECENT, RECENT + 1], 2);
    expect(await s.cold.run(T)).toEqual({ moved: [], skipped: [], failed: [], cleared: 0 });
    expect(s.store.docs.get(D1)!.payloads.size).toBe(2);
    expect(s.objects.calls.filter((c) => c.startsWith('PUT'))).toEqual([]);
  });

  it('cuts a long run into segments of at most maxPayloads, over as many passes as it takes', async () => {
    const s = setup({ maxPayloads: 3, batch: 4 });
    s.store.add(
      D1,
      Array.from({ length: 10 }, (_, i) => OLD + i),
      10,
    );
    const before = written(s, D1);
    const r = await s.cold.run(T);
    expect(r.failed).toEqual([]);
    expect(r.moved).toMatchObject([{ doc: D1, payloads: 10 }]);
    const rows = [...s.store.docs.get(D1)!.rows.values()].sort((a, b) => a.fromSeq - b.fromSeq);
    for (const row of rows) {
      expect(row.toSeq - row.fromSeq + 1).toBeLessThanOrEqual(3);
      expect(row.payloads).toBe(row.toSeq - row.fromSeq + 1);
      expect(row.objectKey).toBe(objectKeys.segment(T, D1, row.fromSeq, row.toSeq));
    }
    // The segments cover 1 to 10 with no gap and no overlap.
    expect(rows.flatMap((row) => [row.fromSeq, row.toSeq]).join(',')).toMatch(/^1,.*,10$/);
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.fromSeq).toBe(rows[i - 1]!.toSeq + 1);
    expect(s.store.docs.get(D1)!.payloads.size).toBe(0);
    expect(await readAll(s, D1)).toEqual(before);
  });

  it('cuts a segment by the bytes of its payloads too', async () => {
    const s = setup({ maxBytes: 1 });
    s.store.add(D1, [OLD, OLD + 1, OLD + 2], 3);
    await s.cold.run(T);
    // Every payload is larger than one byte, so each has a segment of its own.
    expect([...s.store.docs.get(D1)!.rows.keys()].sort()).toEqual([1, 2, 3]);
  });

  it('moves a document under a legal hold like any other, and the audit says the hold was seen (criterion 6)', async () => {
    const s = setup({ held: async () => new Set([D1]) });
    s.store.add(D1, [OLD, OLD + 1, RECENT], 2);
    s.store.add(D2, [OLD, OLD + 1, RECENT], 2);
    const r = await s.cold.run(T);
    expect(r.moved).toMatchObject([
      { doc: D1, payloads: 2, held: true },
      { doc: D2, payloads: 2, held: false },
    ]);
    expect([...s.store.docs.get(D1)!.payloads.keys()]).toEqual([3]);
    const events = await s.audit.query(T, { kind: 'history.moved', doc: D1, limit: 5 });
    expect(events[0]).toMatchObject({ data: { held: true, payloads: 2 } });
    // The scheduled task is not one that deletes: the scheduler hands it no hold to respect.
    expect(coldSegmentsTask(s.cold).deletes).toBeUndefined();
  });

  it('uses another age than 30 days when it is given one', async () => {
    const s = setup({ afterMs: 60 * DAY_MS });
    s.store.add(D1, [OLD, OLD + 1], 2);
    expect((await s.cold.run(T)).moved).toEqual([]);
    const t = setup({ afterMs: 10 * DAY_MS });
    t.store.add(D1, [OLD, NOW - 15 * DAY_MS, RECENT], 3);
    expect((await t.cold.run(T)).moved).toMatchObject([{ payloads: 2 }]);
  });
});

describe('what a failed move leaves behind (HIS-029 criterion 3)', () => {
  /** An object store whose next call of one kind fails or lies, once. */
  function faulty(kind: 'put' | 'get' | 'corrupt' | 'delete') {
    let armed = true;
    return (o: MemoryObjectStore): ObjectStore => ({
      put: async (key, body, opts) => {
        if (kind === 'put' && armed) {
          armed = false;
          throw new Error('the object store refused the write');
        }
        return o.put(key, body, opts);
      },
      get: async (key) => {
        if (kind === 'get' && armed) {
          armed = false;
          throw new Error('the object store refused the read');
        }
        if (kind === 'corrupt' && armed) {
          armed = false;
          return new TextEncoder().encode('not what was written');
        }
        return o.get(key);
      },
      exists: (key) => o.exists(key),
      delete: async (key) => {
        if (kind === 'delete' && armed) {
          armed = false;
          throw new Error('the object store refused the delete');
        }
        return o.delete(key);
      },
      list: (prefix) => o.list(prefix),
      signedUrl: (key, at) => o.signedUrl(key, at),
    });
  }

  it.each([
    ['the object cannot be written', 'put', null],
    ['the object cannot be read back', 'get', null],
    ['the object reads back as something else', 'corrupt', null],
    ['the payload rows cannot be deleted', null, 'deletePayloads'],
    ['the index row cannot be updated', null, 'setMoved'],
    ['the transaction cannot be committed', null, 'commit'],
  ] as const)(
    'keeps every payload in the table when %s, and leaves no object and no row',
    async (_name, objectFault, storeFault) => {
      const s = setup({}, objectFault ? faulty(objectFault) : undefined);
      s.store.add(D1, [OLD, OLD + 1, OLD + 2, RECENT], 3);
      const before = written(s, D1);
      s.store.fault = storeFault;

      const r = await s.cold.run(T);
      expect(r.moved).toEqual([]);
      expect(r.failed).toHaveLength(1);
      expect(r.failed[0]).toMatchObject({ doc: D1 });
      expect(r.failed[0]!.reason).toMatch(/^segment 1-3: /);
      const d = s.store.docs.get(D1)!;
      expect([...d.payloads.keys()]).toEqual([1, 2, 3, 4]);
      expect(d.rows.size).toBe(0);
      expect(await segmentKeys(s, D1)).toEqual([]);
      expect(await readAll(s, D1)).toEqual(before);
      expect(await s.audit.query(T, { kind: 'history.moved', limit: 5 })).toEqual([]);

      // The next run, with nothing in its way, moves them.
      const next = await s.cold.run(T);
      expect(next.failed).toEqual([]);
      expect(next.moved).toMatchObject([{ doc: D1, payloads: 3 }]);
      expect([...d.payloads.keys()]).toEqual([4]);
      expect(await readAll(s, D1)).toEqual(before);
    },
  );

  it('leaves a pending row when the object cannot be removed either, and the next run clears it first', async () => {
    // The read-back fails, and then so does the delete of the object that was written.
    let reads = 0;
    let deletes = 0;
    const s = setup({}, (o) => ({
      put: (key, body, opts) => o.put(key, body, opts),
      get: async (key) => {
        reads++;
        if (reads === 1) throw new Error('the object store refused the read');
        return o.get(key);
      },
      exists: (key) => o.exists(key),
      delete: async (key) => {
        deletes++;
        if (deletes === 1) throw new Error('the object store refused the delete');
        return o.delete(key);
      },
      list: (prefix) => o.list(prefix),
      signedUrl: (key, at) => o.signedUrl(key, at),
    }));
    s.store.add(D1, [OLD, OLD + 1, RECENT], 2);
    const before = written(s, D1);

    const r = await s.cold.run(T);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]!.reason).toMatch(/could not be cleared yet/);
    const d = s.store.docs.get(D1)!;
    // The payloads are in the table; the object is there but its row is pending, so nothing reads it.
    expect([...d.payloads.keys()]).toEqual([1, 2, 3]);
    expect([...d.rows.values()]).toMatchObject([{ fromSeq: 1, toSeq: 2, state: 'pending' }]);
    expect(await segmentKeys(s, D1)).toHaveLength(1);
    expect(await readAll(s, D1)).toEqual(before);

    const next = await s.cold.run(T);
    expect(next.cleared).toBe(1);
    expect(next.failed).toEqual([]);
    expect(next.moved).toMatchObject([{ doc: D1, payloads: 2 }]);
    expect([...d.rows.values()]).toMatchObject([{ fromSeq: 1, toSeq: 2, state: 'moved' }]);
    expect(await readAll(s, D1)).toEqual(before);
  });

  it('clears what a run that died left: a pending row and an object nobody reads', async () => {
    const s = setup();
    const d = s.store.add(D1, [OLD, OLD + 1, OLD + 2, RECENT], 3);
    const before = written(s, D1);
    // A run died after it wrote the object of 1-2 and before it deleted anything.
    const key = objectKeys.segment(T, D1, 1, 2);
    d.rows.set(1, { fromSeq: 1, toSeq: 2, objectKey: key, state: 'pending', payloads: 0 });
    await s.objects.put(key, new TextEncoder().encode('half a segment'));

    const r = await s.cold.run(T);
    expect(r.cleared).toBe(1);
    expect(r.failed).toEqual([]);
    // The stale object is gone, and the payloads moved in one segment of the run they form now.
    expect(await segmentKeys(s, D1)).toEqual([objectKeys.segment(T, D1, 1, 3)]);
    expect([...d.rows.values()]).toMatchObject([{ fromSeq: 1, toSeq: 3, state: 'moved' }]);
    expect(await readAll(s, D1)).toEqual(before);
  });

  it('touches nothing when the move did commit and only its answer was lost', async () => {
    const s = setup();
    const d = s.store.add(D1, [OLD, OLD + 1, RECENT], 2);
    const before = written(s, D1);
    // The fault fires on the transaction that moves, after it has committed.
    s.store.fault = 'answer-lost';
    const r = await s.cold.run(T);
    // The run cannot tell that it succeeded, so it reports the document; nothing is lost and the
    // segment is read.
    expect(r.failed).toHaveLength(1);
    expect([...d.payloads.keys()]).toEqual([3]);
    expect([...d.rows.values()]).toMatchObject([
      { fromSeq: 1, toSeq: 2, state: 'moved', payloads: 2 },
    ]);
    expect(await segmentKeys(s, D1)).toHaveLength(1);
    expect(await readAll(s, D1)).toEqual(before);
    expect(await s.cold.run(T)).toEqual({ moved: [], skipped: [], failed: [], cleared: 0 });
  });

  it('does not move a payload whose stored bytes differ from the hash of its commit', async () => {
    const s = setup();
    const d = s.store.add(D1, [OLD, OLD + 1, RECENT], 2);
    // The row of seq 2 holds the payload of another commit.
    d.payloads.set(2, new Uint8Array(encodeCommit(D1, commitOf(9, OLD)).payload));
    const r = await s.cold.run(T);
    expect(r.moved).toEqual([]);
    expect(r.failed[0]!.reason).toMatch(/does not match its recorded hash/);
    expect([...d.payloads.keys()]).toEqual([1, 2, 3]);
    expect(d.rows.size).toBe(0);
    expect(await segmentKeys(s, D1)).toEqual([]);
  });

  it('goes on with the next document when one fails', async () => {
    const s = setup();
    s.store.add(D1, [OLD, OLD + 1], 2);
    s.store.add(D2, [OLD, OLD + 1], 2);
    s.store.fault = 'deletePayloads';
    const r = await s.cold.run(T);
    expect(r.failed.map((f) => f.doc)).toEqual([D1]);
    expect(r.moved.map((m) => m.doc)).toEqual([D2]);
    // The scheduled task reports the run as failed after it has done the other documents.
    const t = setup();
    t.store.add(D1, [OLD], 1);
    t.store.fault = 'commit';
    const failed: string[] = [];
    await expect(
      coldSegmentsTask(t.cold, (_tenant, f) => failed.push(...f.map((x) => x.doc))).forTenant!(
        T,
        NOW,
        { held: new Set() },
      ),
    ).rejects.toThrow(/could not be moved/);
    expect(failed).toEqual([D1]);
  });

  it('counts the payloads moved as the result of the scheduled task', async () => {
    const s = setup();
    s.store.add(D1, [OLD, OLD + 1, RECENT], 2);
    s.store.add(D2, [OLD, OLD + 1, OLD + 2], 3);
    const task = coldSegmentsTask(s.cold);
    expect(task.name).toBe('payloads.cold');
    expect(task.everyMs).toBe(DAY_MS);
    expect(await task.forTenant!(T, NOW, { held: new Set() })).toBe(5);
  });

  it('never loses a payload, whatever fails and however often the run is repeated (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 12 }),
        fc.integer({ min: 0, max: 12 }),
        fc.integer({ min: 1, max: 4 }),
        fc.array(
          fc.constantFrom<Fault | 'put' | 'get' | 'corrupt' | 'delete' | 'none'>(
            'none',
            'deletePayloads',
            'setMoved',
            'commit',
            'answer-lost',
            'put',
            'get',
            'corrupt',
            'delete',
          ),
          { minLength: 1, maxLength: 4 },
        ),
        async (oldFlags, checkpoint, maxPayloads, faults) => {
          let objectFault: 'put' | 'get' | 'corrupt' | 'delete' | null = null;
          const s = setup({ maxPayloads }, (o) => ({
            put: async (key, body, opts) => {
              if (objectFault === 'put') {
                objectFault = null;
                throw new Error('put');
              }
              return o.put(key, body, opts);
            },
            get: async (key) => {
              if (objectFault === 'get') {
                objectFault = null;
                throw new Error('get');
              }
              if (objectFault === 'corrupt') {
                objectFault = null;
                return new Uint8Array([1, 2, 3]);
              }
              return o.get(key);
            },
            exists: (key) => o.exists(key),
            delete: async (key) => {
              if (objectFault === 'delete') {
                objectFault = null;
                throw new Error('delete');
              }
              return o.delete(key);
            },
            list: (prefix) => o.list(prefix),
            signedUrl: (key, at) => o.signedUrl(key, at),
          }));
          const times = oldFlags.map((old, i) => (old ? OLD + i : RECENT + i));
          const d = s.store.add(D1, times, checkpoint === 0 ? null : checkpoint);
          const before = written(s, D1);
          for (const fault of faults) {
            if (fault === 'put' || fault === 'get' || fault === 'corrupt' || fault === 'delete')
              objectFault = fault;
            else if (fault !== 'none') s.store.fault = fault;
            await s.cold.run(T);
            s.store.fault = null;
            objectFault = null;
            // After every run, whatever it met: each payload reads as it was written.
            expect(await readAll(s, D1)).toEqual(before);
          }
          // Two clean runs settle everything that may move, and leave nothing half done.
          await s.cold.run(T);
          const last = await s.cold.run(T);
          expect(last).toEqual({ moved: [], skipped: [], failed: [], cleared: 0 });
          expect(await readAll(s, D1)).toEqual(before);
          const movable = times
            .map((time, i) => ({ seq: i + 1, time }))
            .filter((c) => checkpoint !== 0 && c.seq <= checkpoint && c.time < NOW - 30 * DAY_MS)
            .map((c) => c.seq);
          expect([...d.payloads.keys()].sort((a, b) => a - b)).toEqual(
            times.map((_, i) => i + 1).filter((seq) => !movable.includes(seq)),
          );
          expect([...d.rows.values()].every((row) => row.state === 'moved')).toBe(true);
          // Every object under the prefix is one a moved row names.
          expect((await segmentKeys(s, D1)).sort()).toEqual(
            [...d.rows.values()].map((row) => row.objectKey).sort(),
          );
        },
      ),
      { numRuns: 150 },
    );
  });

  it('gives each payload to one segment only when two runs work at the same time', async () => {
    const s = setup({ maxPayloads: 2 });
    const d = s.store.add(
      D1,
      Array.from({ length: 7 }, (_, i) => OLD + i),
      7,
    );
    const before = written(s, D1);
    const [a, b] = await Promise.all([s.cold.run(T), s.cold.run(T)]);
    const moved = [...a.moved, ...b.moved].reduce((n, m) => n + m.payloads, 0);
    expect(moved).toBe(7);
    expect(d.payloads.size).toBe(0);
    const rows = [...d.rows.values()].sort((x, y) => x.fromSeq - y.fromSeq);
    expect(rows.every((row) => row.state === 'moved')).toBe(true);
    expect(rows.reduce((n, row) => n + row.payloads, 0)).toBe(7);
    for (let i = 1; i < rows.length; i++)
      expect(rows[i]!.fromSeq).toBeGreaterThan(rows[i - 1]!.toSeq);
    expect(await readAll(s, D1)).toEqual(before);
    // What one run could not start because the other held the range is cleared by a later run.
    await s.cold.run(T);
    expect((await segmentKeys(s, D1)).sort()).toEqual(rows.map((row) => row.objectKey).sort());
  });
});

describe('documents with their own key (HIS-041)', () => {
  /** The real sealer of a document, over a data key made for the test. */
  async function sealerOf(): Promise<DocumentSealer> {
    const dek = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    return new DocumentSealer(dek);
  }

  it('opens the sealed payload rows with the key of the document before it moves them', async () => {
    const sealer = await sealerOf();
    const s = setup({ documentKeys: { sealerFor: async () => sealer } });
    const d = s.store.add(D1, [OLD, OLD + 1, RECENT], 2);
    const before = written(s, D1);
    for (const [seq, bytes] of d.payloads)
      d.payloads.set(seq, await sealer.seal(`${D1}/${seq}`, bytes));
    const r = await s.cold.run(T);
    expect(r.failed).toEqual([]);
    expect(r.moved).toMatchObject([{ doc: D1, payloads: 2 }]);
    const wanted = new Map([1, 2].map((seq) => [seq, d.commits.get(seq)!.hash] as const));
    const got = await s.reader.read({ tenant: T, doc: D1 }, wanted, [...d.rows.values()]);
    expect(got.get(1)).toEqual(before.get(1));
    expect(got.get(2)).toEqual(before.get(2));
  });

  it('skips a document whose key was destroyed, and moves nothing of it', async () => {
    const sealer = await sealerOf();
    const s = setup({
      documentKeys: {
        sealerFor: async () => {
          throw new DocumentKeyDestroyedError(D1);
        },
      },
    });
    const d = s.store.add(D1, [OLD, OLD + 1], 2);
    for (const [seq, bytes] of d.payloads)
      d.payloads.set(seq, await sealer.seal(`${D1}/${seq}`, bytes));
    const r = await s.cold.run(T);
    expect(r).toEqual({
      moved: [],
      skipped: [{ doc: D1, reason: 'key-destroyed' }],
      failed: [],
      cleared: 0,
    });
    expect(d.payloads.size).toBe(2);
    expect(d.rows.size).toBe(0);
  });

  it('skips a document whose rows are sealed when no key can open them', async () => {
    const sealer = await sealerOf();
    const s = setup();
    const d = s.store.add(D1, [OLD, OLD + 1], 2);
    for (const [seq, bytes] of d.payloads)
      d.payloads.set(seq, await sealer.seal(`${D1}/${seq}`, bytes));
    const r = await s.cold.run(T);
    expect(r.skipped).toEqual([{ doc: D1, reason: 'key-destroyed' }]);
    expect(r.moved).toEqual([]);
    expect(d.payloads.size).toBe(2);
    expect(d.rows.size).toBe(0);
    expect(await segmentKeys(s, D1)).toEqual([]);
  });
});

describe('taking payloads out of cold segments (HIS-029, for HIS-032 and HIS-040)', () => {
  async function moved(count = 5, maxPayloads = 3) {
    const s = setup({ maxPayloads });
    const d = s.store.add(
      D1,
      Array.from({ length: count }, (_, i) => OLD + i),
      count,
    );
    const before = written(s, D1);
    const r = await s.cold.run(T);
    if (r.failed.length) throw new Error(r.failed[0]!.reason);
    return { s, d, before };
  }

  it('writes the segment again without the payloads, and a read finds them in no store', async () => {
    const { s, d, before } = await moved();
    // Segments 1-3 and 4-5.
    const r = await s.cold.remove(T, D1, [2, 4]);
    expect(r.removed).toEqual([2, 4]);
    expect(r.objects.sort()).toEqual([
      objectKeys.segment(T, D1, 1, 3),
      objectKeys.segment(T, D1, 4, 5),
    ]);
    expect([...d.rows.values()].map((row) => [row.fromSeq, row.state, row.payloads])).toEqual([
      [1, 'moved', 2],
      [4, 'moved', 1],
    ]);
    const now = await readAll(s, D1);
    expect([...now.keys()].sort()).toEqual([1, 3, 5]);
    for (const seq of [1, 3, 5]) expect(now.get(seq)).toEqual(before.get(seq));
    // The text of the removed payloads is in no object any more.
    for (const key of await segmentKeys(s, D1)) {
      const text = zstdDecompressSync((await s.objects.get(key))!).toString('utf8');
      expect(text).not.toContain('text of commit 2');
      expect(text).not.toContain('text of commit 4');
    }
  });

  it('deletes the object and the row of a segment left with nothing', async () => {
    const { s, d } = await moved();
    const r = await s.cold.remove(T, D1, [4, 5]);
    expect(r.removed).toEqual([4, 5]);
    expect([...d.rows.keys()]).toEqual([1]);
    expect(await segmentKeys(s, D1)).toEqual([objectKeys.segment(T, D1, 1, 3)]);
    // Nothing moves back: the payloads are gone, as thinning means them to be.
    expect((await s.cold.run(T)).moved).toEqual([]);
  });

  it('removes nothing for a commit that no segment holds, and writes no object', async () => {
    const { s, d } = await moved();
    const puts = () => s.objects.calls.filter((c) => c.startsWith('PUT')).length;
    const before = puts();
    expect(await s.cold.remove(T, D1, [])).toEqual({ removed: [], objects: [] });
    expect(await s.cold.remove(T, D1, [9, 10])).toEqual({ removed: [], objects: [] });
    await s.cold.remove(T, D1, [2]);
    const after = puts();
    expect(await s.cold.remove(T, D1, [2])).toEqual({ removed: [], objects: [] });
    expect(puts()).toBe(after);
    expect(after).toBe(before + 1);
    expect(d.rows.get(1)!.payloads).toBe(2);
  });

  it('rejects when a segment cannot be read, and keeps what it holds', async () => {
    const { s, d } = await moved();
    const key = d.rows.get(1)!.objectKey;
    const bytes = (await s.objects.get(key))!;
    await s.objects.put(key, new TextEncoder().encode('not a segment'));
    await expect(s.cold.remove(T, D1, [2])).rejects.toBeInstanceOf(ColdSegmentUnavailableError);
    expect(d.rows.get(1)).toMatchObject({ state: 'moved', payloads: 3 });
    await s.objects.put(key, bytes);
    expect((await s.cold.remove(T, D1, [2])).removed).toEqual([2]);
  });

  it('clears a segment that was emptied but whose object could not be deleted, at the next run', async () => {
    let fail = true;
    const s = setup({ maxPayloads: 3 }, (o) => ({
      put: (key, body, opts) => o.put(key, body, opts),
      get: (key) => o.get(key),
      exists: (key) => o.exists(key),
      delete: async (key) => {
        if (fail) throw new Error('the object store refused the delete');
        return o.delete(key);
      },
      list: (prefix) => o.list(prefix),
      signedUrl: (key, at) => o.signedUrl(key, at),
    }));
    const d = s.store.add(D1, [OLD, OLD + 1], 2);
    await s.cold.run(T);
    await expect(s.cold.remove(T, D1, [1, 2])).rejects.toThrow(/refused the delete/);
    // The row is pending: no read uses the object, though it is still there.
    expect([...d.rows.values()]).toMatchObject([{ fromSeq: 1, state: 'pending' }]);
    const wanted = new Map([1, 2].map((seq) => [seq, d.commits.get(seq)!.hash] as const));
    const index = [...d.rows.values()].filter((row) => row.state === 'moved');
    expect((await s.reader.read({ tenant: T, doc: D1 }, wanted, index)).size).toBe(0);
    fail = false;
    expect((await s.cold.run(T)).cleared).toBe(1);
    expect(d.rows.size).toBe(0);
    expect(await segmentKeys(s, D1)).toEqual([]);
  });
});
