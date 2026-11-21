// Moving old payloads to cold segments (08 §11; HIS-029): the plan keeps recent payloads and moves
// consecutive old ones into one segment per run; a move removes a payload from the hot store only
// after the segment is written and read back with matching hashes; a range read from both stores
// gives what it gave before the move; an unreadable segment is `unavailable`; the chain still
// verifies after the move; a legal hold does not stop it. The codec here is the identity on text
// (the service's zstd is not built in this package), so the bytes are UTF-8 of the text.
import { cdmSchema } from '@docedit/model/prosemirror';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type LogBundle, payloadDigest, verifyBundle } from '../src/chain.ts';
import {
  type ColdCandidate,
  type ColdIo,
  type ColdPlanSegment,
  type HotPayloads,
  type SegmentCodec,
  type SegmentObjects,
  coldMovePlan,
  coldPayloads,
  COLD_AFTER_MS,
  dropFromSegment,
  moveSegment,
  readPayloads,
  readSegment,
  type SegmentRef,
  segmentPath,
  segmentText,
} from '../src/cold-segments.ts';
import { thinBundle } from '../src/payload-thinning.ts';
import { DAY_MS } from '../src/thinning.ts';
import { bundleOf } from './bundle.ts';
import { CANARY, LogBuilder, typeAt } from './fixtures.ts';

const schema = cdmSchema();
const NOW = Date.UTC(2026, 10, 13);
const OLD = NOW - 400 * DAY_MS;
const RECENT = NOW - DAY_MS;

/** A codec that keeps the text as UTF-8; `decode` gives the text back. */
const plainCodec: SegmentCodec = {
  async encode(text) {
    return new TextEncoder().encode(text);
  },
  async decode(bytes) {
    return new TextDecoder().decode(bytes);
  },
};

function memoryObjects(): SegmentObjects & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    async put(path, bytes) {
      files.set(path, bytes);
    },
    async get(path) {
      return files.get(path);
    },
  };
}

function memoryHot(
  entries: ReadonlyMap<number, unknown>,
): HotPayloads & { data: Map<number, unknown> } {
  const data = new Map(entries);
  return {
    data,
    async get(seq) {
      return data.get(seq);
    },
    async delete(seqs) {
      for (const s of seqs) data.delete(s);
    },
  };
}

/** Synthetic payloads: JSON values with the canary text in them, so a leak is visible. */
function payloadFor(seq: number, text = ''): unknown {
  return { steps: [{ seq, text: `${CANARY}${seq}${text}` }], retired: [], claimed: [] };
}

/** Candidates and hashes for payloads with the given times (Unix ms), in seq order. */
async function candidatesOf(times: readonly number[]): Promise<{
  candidates: ColdCandidate[];
  payloads: Map<number, unknown>;
  hashes: Map<number, string>;
}> {
  const candidates: ColdCandidate[] = [];
  const payloads = new Map<number, unknown>();
  const hashes = new Map<number, string>();
  for (let i = 0; i < times.length; i++) {
    const seq = i + 1;
    const payload = payloadFor(seq);
    const payloadHash = (await payloadDigest(payload)).hash;
    payloads.set(seq, payload);
    hashes.set(seq, payloadHash);
    candidates.push({ seq, time: times[i]!, payloadHash });
  }
  return { candidates, payloads, hashes };
}

function ioOf(hot: HotPayloads, objects: SegmentObjects): ColdIo {
  return { hot, objects, codec: plainCodec };
}

function planOf(segments: readonly ColdPlanSegment[]): SegmentRef[] {
  return segments.map((s) => ({ fromSeq: s.fromSeq, toSeq: s.toSeq, path: s.path }));
}

describe('segment names and the plan of cold moves (HIS-029)', () => {
  it('names a segment by its range, as segments/{fromSeq}-{toSeq}.payloads.zst (criterion 1, name)', () => {
    expect(segmentPath(3, 7)).toEqual({ ok: true, path: 'segments/3-7.payloads.zst' });
    expect(segmentPath(5, 5)).toEqual({ ok: true, path: 'segments/5-5.payloads.zst' });
  });

  it('refuses a range that is not whole, starts below 1 or ends before it starts', () => {
    expect(segmentPath(0, 3).ok).toBe(false);
    expect(segmentPath(4, 3).ok).toBe(false);
    expect(segmentPath(1.5, 3).ok).toBe(false);
  });

  it('moves payloads older than 30 days by default and keeps the recent ones (criterion 1, plan)', () => {
    expect(COLD_AFTER_MS).toBe(30 * DAY_MS);
    const times = [OLD + 1, OLD + 2, OLD + 3, OLD + 4, OLD + 5, OLD + 6, RECENT + 7, RECENT + 8];
    const candidates = times.map((time, i) => ({ seq: i + 1, time, payloadHash: 'h' + i }));
    const plan = coldMovePlan(candidates, { now: NOW });
    expect(plan).toMatchObject({ ok: true, keep: [7, 8], held: false });
    if (!plan.ok) throw new Error('plan refused');
    expect(plan.segments).toEqual([
      {
        fromSeq: 1,
        toSeq: 6,
        path: 'segments/1-6.payloads.zst',
        entries: [1, 2, 3, 4, 5, 6].map((seq) => ({ seq, payloadHash: 'h' + (seq - 1) })),
      },
    ]);
  });

  it('starts a new segment at a gap, so each segment holds consecutive seq values (criterion 1, plan)', () => {
    const times = [OLD, OLD, RECENT, OLD, OLD, RECENT];
    const candidates = times.map((time, i) => ({ seq: i + 1, time, payloadHash: 'h' }));
    const plan = coldMovePlan(candidates, { now: NOW });
    if (!plan.ok) throw new Error('plan refused');
    expect(plan.segments.map((s) => [s.fromSeq, s.toSeq])).toEqual([
      [1, 2],
      [4, 5],
    ]);
    expect(plan.keep).toEqual([3, 6]);
  });

  it('is the same plan under a legal hold, which is not a reason to keep payloads (criterion 6, plan)', () => {
    const candidates = [OLD + 1, OLD + 2, RECENT].map((time, i) => ({
      seq: i + 1,
      time,
      payloadHash: 'h',
    }));
    const free = coldMovePlan(candidates, { now: NOW });
    const held = coldMovePlan(candidates, { now: NOW, hold: true });
    if (!free.ok || !held.ok) throw new Error('plan refused');
    expect(held.segments).toEqual(free.segments);
    expect(held.keep).toEqual(free.keep);
    expect(held.held).toBe(true);
    expect(free.held).toBe(false);
  });

  it('refuses a time that is not whole, a negative period and a repeated seq', () => {
    expect(coldMovePlan([], { now: 1.5 }).ok).toBe(false);
    expect(coldMovePlan([], { now: NOW, afterMs: -1 }).ok).toBe(false);
    expect(
      coldMovePlan(
        [
          { seq: 1, time: OLD, payloadHash: 'a' },
          { seq: 1, time: OLD, payloadHash: 'a' },
        ],
        { now: NOW },
      ).ok,
    ).toBe(false);
  });

  it('keeps each seq once, in exactly one segment or in keep, and moves only old payloads (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: NOW - 90 * DAY_MS, max: NOW }), { minLength: 0, maxLength: 40 }),
        fc.integer({ min: 1, max: 60 * DAY_MS }),
        (times, afterMs) => {
          const candidates = times.map((time, i) => ({ seq: i + 1, time, payloadHash: 'h' }));
          const plan = coldMovePlan(candidates, { now: NOW, afterMs });
          if (!plan.ok) throw new Error('plan refused');
          const cut = NOW - afterMs;
          const moved = plan.segments.flatMap((s) => s.entries.map((e) => e.seq));
          expect([...moved, ...plan.keep].sort((a, b) => a - b)).toEqual(
            candidates.map((c) => c.seq),
          );
          for (const seg of plan.segments) {
            expect(seg.toSeq - seg.fromSeq + 1).toBe(seg.entries.length);
            expect(seg.path).toBe(`segments/${seg.fromSeq}-${seg.toSeq}.payloads.zst`);
            for (const e of seg.entries) expect(times[e.seq - 1]!).toBeLessThan(cut);
          }
          for (const seq of plan.keep) expect(times[seq - 1]!).toBeGreaterThanOrEqual(cut);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('moving payloads and reading both stores (HIS-029)', () => {
  it('removes a payload from the hot store only after its segment reads back, and reads the same afterwards (criteria 2 and 3)', async () => {
    const times = [OLD, OLD, OLD, RECENT];
    const { candidates, payloads, hashes } = await candidatesOf(times);
    const plan = coldMovePlan(candidates, { now: NOW });
    if (!plan.ok) throw new Error('plan refused');
    const hot = memoryHot(payloads);
    const objects = memoryObjects();
    const seg = plan.segments[0]!;
    const moved = await moveSegment(seg, ioOf(hot, objects));
    expect(moved).toMatchObject({ ok: true, moved: [1, 2, 3] });
    expect([...hot.data.keys()]).toEqual([4]);
    expect(objects.files.has('segments/1-3.payloads.zst')).toBe(true);

    const read = await readPayloads(
      { fromSeq: 1, toSeq: 4, hashes, index: planOf([seg]) },
      ioOf(hot, objects),
    );
    expect(read).toEqual({
      ok: true,
      payloads: [1, 2, 3, 4].map((seq) => ({ seq, payload: payloads.get(seq) })),
    });
  });

  it('never returns a different payload for a range that straddles the boundary (criterion 2, property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 20 }),
        fc.array(fc.integer({ min: 1, max: 20 }), { minLength: 0, maxLength: 6 }),
        async (oldFlags, moveSeqs) => {
          const times = oldFlags.map((o) => (o ? OLD : RECENT));
          const { candidates, payloads, hashes } = await candidatesOf(times);
          const plan = coldMovePlan(candidates, { now: NOW });
          if (!plan.ok) throw new Error('plan refused');
          const hot = memoryHot(payloads);
          const objects = memoryObjects();
          const index: SegmentRef[] = [];
          // Move some segments, as a scheduler would, only the ones the plan allows.
          for (const seg of plan.segments) {
            if (!moveSeqs.some((s) => s >= seg.fromSeq && s <= seg.toSeq)) continue;
            const r = await moveSegment(seg, ioOf(hot, objects));
            expect(r.ok).toBe(true);
            index.push({ fromSeq: seg.fromSeq, toSeq: seg.toSeq, path: seg.path });
          }
          const read = await readPayloads(
            { fromSeq: 1, toSeq: times.length, hashes, index },
            ioOf(hot, objects),
          );
          expect(read).toEqual({
            ok: true,
            payloads: [...payloads.keys()]
              .sort((a, b) => a - b)
              .map((seq) => ({
                seq,
                payload: payloads.get(seq),
              })),
          });
        },
      ),
      { numRuns: 100 },
    );
  });

  it('answers unavailable for the cold part when a segment cannot be read, and reads the hot part alone (criterion 5)', async () => {
    const { candidates, payloads, hashes } = await candidatesOf([OLD, OLD, RECENT]);
    const plan = coldMovePlan(candidates, { now: NOW });
    if (!plan.ok) throw new Error('plan refused');
    const hot = memoryHot(payloads);
    const objects = memoryObjects();
    const seg = plan.segments[0]!;
    await moveSegment(seg, ioOf(hot, objects));
    const broken: SegmentObjects = {
      put: objects.put,
      async get() {
        throw new Error('storage is down');
      },
    };
    const index = planOf([seg]);
    const cold = await readPayloads({ fromSeq: 1, toSeq: 3, hashes, index }, ioOf(hot, broken));
    expect(cold).toMatchObject({ ok: false, status: 'unavailable', seq: 1 });
    const recent = await readPayloads({ fromSeq: 3, toSeq: 3, hashes, index }, ioOf(hot, broken));
    expect(recent).toEqual({ ok: true, payloads: [{ seq: 3, payload: payloads.get(3) }] });
  });

  it('keeps every payload when a step fails, whichever step it is (criterion 3, property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 8 }),
        fc.constantFrom('none', 'put', 'corrupt', 'delete', 'hot-read'),
        async (count, fault) => {
          const times = Array.from({ length: count }, () => OLD);
          const { candidates, payloads, hashes } = await candidatesOf(times);
          const plan = coldMovePlan(candidates, { now: NOW });
          if (!plan.ok) throw new Error('plan refused');
          const base = memoryHot(payloads);
          const objects = memoryObjects();
          const hot: HotPayloads = {
            async get(seq) {
              if (fault === 'hot-read') throw new Error('hot store is down');
              return base.get(seq);
            },
            async delete(seqs) {
              if (fault === 'delete') throw new Error('delete failed');
              return base.delete(seqs);
            },
          };
          const store: SegmentObjects = {
            async put(path, bytes) {
              if (fault === 'put') throw new Error('put failed');
              return objects.put(path, bytes);
            },
            async get(path) {
              if (fault === 'corrupt') return new TextEncoder().encode('{"format":"other"}');
              return objects.get(path);
            },
          };
          const seg = plan.segments[0]!;
          const result = await moveSegment(seg, ioOf(hot, store));
          if (fault === 'none') {
            expect(result.ok).toBe(true);
          } else {
            expect(result.ok).toBe(false);
          }
          // Every payload is either still hot, or deleted only after a segment read back with its hash.
          for (const seq of hashes.keys()) {
            if (base.data.has(seq)) continue;
            const bytes = objects.files.get(seg.path);
            expect(bytes).toBeDefined();
            const text = new TextDecoder().decode(bytes!);
            expect(text).toContain(`"seq":${seq}`);
          }
          // Nothing is removed while the read-back has not confirmed the segment.
          if (fault !== 'none') expect(base.data.size).toBe(count);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('refuses to move a payload whose stored hash differs from the metadata, and moves nothing (criterion 3)', async () => {
    const { candidates, payloads } = await candidatesOf([OLD, OLD]);
    const plan = coldMovePlan(candidates, { now: NOW });
    if (!plan.ok) throw new Error('plan refused');
    const hot = memoryHot(new Map([...payloads, [2, payloadFor(2, ' changed')]]));
    const objects = memoryObjects();
    const result = await moveSegment(plan.segments[0]!, ioOf(hot, objects));
    expect(result).toMatchObject({ ok: false, status: 'mismatch' });
    expect(hot.data.size).toBe(2);
    expect(objects.files.size).toBe(0);
  });

  it('refuses a move of a payload that is not in the hot store (criterion 3)', async () => {
    const { candidates, payloads } = await candidatesOf([OLD, OLD]);
    const plan = coldMovePlan(candidates, { now: NOW });
    if (!plan.ok) throw new Error('plan refused');
    payloads.delete(2);
    const result = await moveSegment(plan.segments[0]!, ioOf(memoryHot(payloads), memoryObjects()));
    expect(result).toMatchObject({ ok: false, status: 'missing' });
  });
});

describe('the chain after a cold move (HIS-029)', () => {
  it('verifies after the move, with the payload hashes read back from the segments (criterion 4)', async () => {
    const b = new LogBuilder();
    for (let i = 1; i <= 6; i++)
      b.add(
        (d) => typeAt(d, i % 2 ? 'pIntro0000000001' : 'pSecret00000001B', 0, `${CANARY}${i} `),
        {
          user: i % 2 ? 'bob' : 'carol',
          time: i <= 4 ? OLD + i : RECENT + i,
        },
      );
    const bundle: LogBundle = await bundleOf(b.log, [{ seq: 0, doc: b.docs[0]! }]);
    const candidates: ColdCandidate[] = bundle.commits.map((c) => ({
      seq: c.meta.seq,
      time: Date.parse(c.meta.time),
      payloadHash: c.payloadHash,
    }));
    const plan = coldMovePlan(candidates, { now: NOW });
    if (!plan.ok) throw new Error('plan refused');
    expect(plan.keep).toEqual([5, 6]);

    const hot = memoryHot(new Map(bundle.commits.map((c) => [c.meta.seq, c.payload])));
    const objects = memoryObjects();
    const moved: number[] = [];
    for (const seg of plan.segments) {
      const r = await moveSegment(seg, ioOf(hot, objects));
      if (!r.ok) throw new Error(r.reason);
      moved.push(...r.moved);
    }
    // The hashes read back from the segment objects are the ones the metadata records.
    const back = await readPayloads(
      {
        fromSeq: 1,
        toSeq: 4,
        hashes: new Map(bundle.commits.map((c) => [c.meta.seq, c.payloadHash])),
        index: planOf(plan.segments),
      },
      ioOf(hot, objects),
    );
    expect(back.ok).toBe(true);

    const thinned = thinBundle(bundle, { remove: moved, keep: plan.keep, keptForVersions: [] });
    if (!thinned.ok) throw new Error(thinned.reason);
    const report = await verifyBundle(thinned.bundle, { schema });
    expect(report.problems).toEqual([]);
    expect(report).toMatchObject({ status: 'intact', payloadsAbsent: 4, payloadsChecked: 2 });
  });

  it('verifies a bundle rebuilt from both stores, with the payloads and payload hashes read from the segments (criterion 4)', async () => {
    const b = new LogBuilder();
    for (let i = 1; i <= 6; i++)
      b.add(
        (d) => typeAt(d, i % 2 ? 'pIntro0000000001' : 'pSecret00000001B', 0, `${CANARY}${i} `),
        {
          user: i % 2 ? 'bob' : 'carol',
          time: i <= 4 ? OLD + i : RECENT + i,
        },
      );
    const bundle: LogBundle = await bundleOf(b.log, [{ seq: 0, doc: b.docs[0]! }]);
    const candidates: ColdCandidate[] = bundle.commits.map((c) => ({
      seq: c.meta.seq,
      time: Date.parse(c.meta.time),
      payloadHash: c.payloadHash,
    }));
    const plan = coldMovePlan(candidates, { now: NOW });
    if (!plan.ok) throw new Error('plan refused');
    const hot = memoryHot(new Map(bundle.commits.map((c) => [c.meta.seq, c.payload])));
    const objects = memoryObjects();
    const index: SegmentRef[] = [];
    for (const seg of plan.segments) {
      const r = await moveSegment(seg, ioOf(hot, objects));
      if (!r.ok) throw new Error(r.reason);
      index.push(r.segment);
    }
    expect([...hot.data.keys()]).toEqual([5, 6]);

    // The payload hashes as the segment objects record them, decoded with the segment codec.
    const segmentHashes = new Map<number, string>();
    for (const ref of index) {
      const bytes = objects.files.get(ref.path);
      if (bytes === undefined) throw new Error('segment missing');
      const parsed = JSON.parse(await plainCodec.decode(bytes)) as {
        entries: Array<{ seq: number; payloadHash: string }>;
      };
      for (const e of parsed.entries) segmentHashes.set(e.seq, e.payloadHash);
    }
    expect([...segmentHashes.keys()]).toEqual([1, 2, 3, 4]);

    // Every payload, from both stores, read through readPayloads.
    const back = await readPayloads(
      {
        fromSeq: 1,
        toSeq: bundle.head.seq,
        hashes: new Map(bundle.commits.map((c) => [c.meta.seq, c.payloadHash])),
        index,
      },
      ioOf(hot, objects),
    );
    if (!back.ok) throw new Error(back.reason);
    const readBack = new Map(back.payloads.map((p) => [p.seq, p.payload]));

    // The bundle as a verifier would assemble it after the move: metadata and links from the
    // commit rows, payloads from both stores, and the payload hash of a moved commit from its segment.
    const rebuilt: LogBundle = {
      ...bundle,
      commits: bundle.commits.map((c) => ({
        meta: c.meta,
        prevHash: c.prevHash,
        hash: c.hash,
        payloadHash: segmentHashes.get(c.meta.seq) ?? c.payloadHash,
        payload: readBack.get(c.meta.seq),
      })),
    };
    const report = await verifyBundle(rebuilt, { schema });
    expect(report.problems).toEqual([]);
    expect(report).toMatchObject({
      status: 'intact',
      payloadsAbsent: 0,
      payloadsChecked: bundle.commits.length,
    });

    // A segment that records a different payload hash breaks the chain: the hash read from the
    // segment is the one the verifier used.
    const forged: LogBundle = {
      ...rebuilt,
      commits: rebuilt.commits.map((c) =>
        c.meta.seq === 2 ? { ...c, payloadHash: '0'.repeat(64) } : c,
      ),
    };
    const broken = await verifyBundle(forged, { schema });
    expect(broken.status).toBe('altered');
  });
});

describe('the size of a segment (HIS-029)', () => {
  it('cuts a long run into segments of at most maxPayloads consecutive payloads', () => {
    const candidates = Array.from({ length: 7 }, (_, i) => ({
      seq: i + 1,
      time: OLD + i,
      payloadHash: 'h',
    }));
    const plan = coldMovePlan(candidates, { now: NOW, maxPayloads: 3 });
    if (!plan.ok) throw new Error('plan refused');
    expect(plan.segments.map((s) => [s.fromSeq, s.toSeq, s.path])).toEqual([
      [1, 3, 'segments/1-3.payloads.zst'],
      [4, 6, 'segments/4-6.payloads.zst'],
      [7, 7, 'segments/7-7.payloads.zst'],
    ]);
  });

  it('cuts a run when the bytes of its payloads would pass maxBytes, and gives a larger payload a segment of its own', () => {
    const sizes = [40, 40, 40, 500, 10, 10];
    const candidates = sizes.map((size, i) => ({
      seq: i + 1,
      time: OLD + i,
      payloadHash: 'h',
      size,
    }));
    const plan = coldMovePlan(candidates, { now: NOW, maxBytes: 100 });
    if (!plan.ok) throw new Error('plan refused');
    expect(plan.segments.map((s) => [s.fromSeq, s.toSeq])).toEqual([
      [1, 2],
      [3, 3],
      [4, 4],
      [5, 6],
    ]);
  });

  it('refuses a limit that is not a whole number of 1 or more, and a size that is not a whole number', () => {
    expect(coldMovePlan([], { now: NOW, maxPayloads: 0 }).ok).toBe(false);
    expect(coldMovePlan([], { now: NOW, maxPayloads: 1.5 }).ok).toBe(false);
    expect(coldMovePlan([], { now: NOW, maxBytes: 0 }).ok).toBe(false);
    expect(coldMovePlan([{ seq: 1, time: OLD, payloadHash: 'h', size: -1 }], { now: NOW }).ok).toBe(
      false,
    );
  });

  it('keeps each seq once and every segment within both limits, whatever the limits (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ old: fc.boolean(), size: fc.integer({ min: 0, max: 300 }) }), {
          minLength: 0,
          maxLength: 40,
        }),
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 1, max: 400 }),
        (rows, maxPayloads, maxBytes) => {
          const candidates = rows.map((r, i) => ({
            seq: i + 1,
            time: r.old ? OLD : RECENT,
            payloadHash: 'h',
            size: r.size,
          }));
          const plan = coldMovePlan(candidates, { now: NOW, maxPayloads, maxBytes });
          if (!plan.ok) throw new Error('plan refused');
          const moved = plan.segments.flatMap((s) => s.entries.map((e) => e.seq));
          expect([...moved, ...plan.keep].sort((a, b) => a - b)).toEqual(
            candidates.map((c) => c.seq),
          );
          for (const seg of plan.segments) {
            expect(seg.entries.length).toBeLessThanOrEqual(maxPayloads);
            expect(seg.toSeq - seg.fromSeq + 1).toBe(seg.entries.length);
            expect(seg.path).toBe(`segments/${seg.fromSeq}-${seg.toSeq}.payloads.zst`);
            const bytes = seg.entries.reduce((n, e) => n + rows[e.seq - 1]!.size, 0);
            // A single payload larger than the limit is alone in its segment.
            if (seg.entries.length > 1) expect(bytes).toBeLessThanOrEqual(maxBytes);
          }
          // The limits never change which payloads move.
          const free = coldMovePlan(candidates, { now: NOW });
          if (!free.ok) throw new Error('plan refused');
          expect(plan.keep).toEqual(free.keep);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('reading the cold segments alone (HIS-029)', () => {
  /** Three old payloads moved into one segment, and the pieces a reader needs. */
  async function moved() {
    const { candidates, payloads, hashes } = await candidatesOf([OLD, OLD, OLD]);
    const plan = coldMovePlan(candidates, { now: NOW });
    if (!plan.ok) throw new Error('plan refused');
    const hot = memoryHot(payloads);
    const objects = memoryObjects();
    const seg = plan.segments[0]!;
    const r = await moveSegment(seg, ioOf(hot, objects));
    if (!r.ok) throw new Error(r.reason);
    return { payloads, hashes, hot, objects, seg, index: planOf([seg]) };
  }

  it('gives the payloads asked for, each checked against the hash of its commit', async () => {
    const m = await moved();
    const wanted = new Map([
      [1, m.hashes.get(1)!],
      [3, m.hashes.get(3)!],
    ]);
    const got = await coldPayloads(wanted, m.index, { objects: m.objects, codec: plainCodec });
    if (!got.ok) throw new Error(got.reason);
    expect([...got.payloads]).toEqual([
      [1, m.payloads.get(1)],
      [3, m.payloads.get(3)],
    ]);
    expect(got.absent).toEqual([]);
  });

  it('reads each segment object once, however many payloads are asked of it', async () => {
    const m = await moved();
    let gets = 0;
    const counting: SegmentObjects = {
      put: m.objects.put,
      async get(path) {
        gets++;
        return m.objects.get(path);
      },
    };
    const got = await coldPayloads(m.hashes, m.index, { objects: counting, codec: plainCodec });
    expect(got.ok).toBe(true);
    expect(gets).toBe(1);
  });

  it('reports as absent a commit no segment covers and one its segment no longer holds', async () => {
    const m = await moved();
    const dropped = await dropFromSegment(m.seg.path, [2], {
      objects: m.objects,
      codec: plainCodec,
    });
    expect(dropped).toEqual({ ok: true, removed: [2], remaining: 2, written: true });
    const wanted = new Map([...m.hashes, [9, 'f'.repeat(64)]]);
    const got = await coldPayloads(wanted, m.index, { objects: m.objects, codec: plainCodec });
    if (!got.ok) throw new Error(got.reason);
    expect([...got.payloads.keys()]).toEqual([1, 3]);
    expect(got.absent).toEqual([2, 9]);
  });

  it('answers unavailable, with the commit, when the object is missing, unreadable or not a segment (criterion 5)', async () => {
    const m = await moved();
    const io = (objects: SegmentObjects) => ({ objects, codec: plainCodec });
    const missing = await coldPayloads(m.hashes, m.index, io(memoryObjects()));
    expect(missing).toMatchObject({ ok: false, status: 'unavailable', seq: 1 });
    const down = await coldPayloads(
      m.hashes,
      m.index,
      io({
        put: m.objects.put,
        async get() {
          throw new Error('storage is down');
        },
      }),
    );
    expect(down).toMatchObject({ ok: false, status: 'unavailable', seq: 1 });
    const other = memoryObjects();
    await other.put(m.seg.path, new TextEncoder().encode('{"format":"other","entries":[]}'));
    expect(await coldPayloads(m.hashes, m.index, io(other))).toMatchObject({
      ok: false,
      status: 'unavailable',
    });
    // Nothing is read for a commit list that is empty.
    expect(await coldPayloads(new Map(), m.index, io(memoryObjects()))).toEqual({
      ok: true,
      payloads: new Map(),
      absent: [],
    });
  });

  it('answers mismatch for a payload that was changed in the segment, and for a recorded hash that is not the commit hash (criterion 4)', async () => {
    const m = await moved();
    const entries = [1, 2, 3].map((seq) => ({
      seq,
      payloadHash: m.hashes.get(seq)!,
      payload: m.payloads.get(seq),
    }));
    // The payload of seq 2 is changed and its recorded hash is left as it was.
    const changed = memoryObjects();
    await changed.put(
      m.seg.path,
      await plainCodec.encode(
        segmentText(entries.map((e) => (e.seq === 2 ? { ...e, payload: payloadFor(2, ' x') } : e))),
      ),
    );
    const io = (objects: SegmentObjects) => ({ objects, codec: plainCodec });
    expect(await coldPayloads(m.hashes, m.index, io(changed))).toMatchObject({
      ok: false,
      status: 'mismatch',
      seq: 2,
    });
    // The payload of seq 3 is changed and the recorded hash is made to fit it: the hash the segment
    // records is then not the one the chain covers.
    const forgedPayload = payloadFor(3, ' y');
    const forged = memoryObjects();
    await forged.put(
      m.seg.path,
      await plainCodec.encode(
        segmentText(
          await Promise.all(
            entries.map(async (e) =>
              e.seq === 3
                ? {
                    seq: 3,
                    payload: forgedPayload,
                    payloadHash: (await payloadDigest(forgedPayload)).hash,
                  }
                : e,
            ),
          ),
        ),
      ),
    );
    expect(await coldPayloads(m.hashes, m.index, io(forged))).toMatchObject({
      ok: false,
      status: 'mismatch',
      seq: 3,
    });
    // `readPayloads` refuses the same two objects.
    for (const objects of [changed, forged])
      expect(
        await readPayloads(
          { fromSeq: 1, toSeq: 3, hashes: m.hashes, index: m.index },
          ioOf(memoryHot(new Map()), objects),
        ),
      ).toMatchObject({ ok: false, status: 'mismatch' });
  });
});

describe('removing payloads from a segment (HIS-029, for HIS-032 and HIS-040)', () => {
  async function segmentOf(count: number) {
    const { candidates, payloads, hashes } = await candidatesOf(
      Array.from({ length: count }, () => OLD),
    );
    const plan = coldMovePlan(candidates, { now: NOW });
    if (!plan.ok) throw new Error('plan refused');
    const objects = memoryObjects();
    const seg = plan.segments[0]!;
    const r = await moveSegment(seg, ioOf(memoryHot(payloads), objects));
    if (!r.ok) throw new Error(r.reason);
    return { payloads, hashes, objects, seg };
  }

  it('writes the object again without the payloads, under the same name, and the rest reads as before', async () => {
    const s = await segmentOf(5);
    const io = { objects: s.objects, codec: plainCodec };
    const before = s.objects.files.get(s.seg.path)!;
    const r = await dropFromSegment(s.seg.path, [4, 2, 99], io);
    expect(r).toEqual({ ok: true, removed: [2, 4], remaining: 3, written: true });
    const text = new TextDecoder().decode(s.objects.files.get(s.seg.path)!);
    expect(text).not.toContain(`${CANARY}2`);
    expect(text).not.toContain(`${CANARY}4`);
    expect(new TextDecoder().decode(before)).toContain(`${CANARY}2`);
    const back = await readSegment(s.seg.path, io);
    if (!back.ok) throw new Error(back.reason);
    expect([...back.entries.keys()]).toEqual([1, 3, 5]);
    for (const seq of [1, 3, 5]) {
      expect(back.entries.get(seq)!.payload).toEqual(s.payloads.get(seq));
      expect(back.entries.get(seq)!.payloadHash).toBe(s.hashes.get(seq));
    }
    expect([...s.objects.files.keys()]).toEqual([s.seg.path]);
  });

  it('writes nothing when no payload of the list is in the segment, and nothing when none would remain', async () => {
    const s = await segmentOf(2);
    let puts = 0;
    const counting: SegmentObjects = {
      async put(path, bytes) {
        puts++;
        return s.objects.put(path, bytes);
      },
      get: s.objects.get,
    };
    const io = { objects: counting, codec: plainCodec };
    expect(await dropFromSegment(s.seg.path, [7, 8], io)).toEqual({
      ok: true,
      removed: [],
      remaining: 2,
      written: false,
    });
    expect(await dropFromSegment(s.seg.path, [1, 2], io)).toEqual({
      ok: true,
      removed: [1, 2],
      remaining: 0,
      written: false,
    });
    expect(puts).toBe(0);
    // The object is the caller's to remove: it is still as it was.
    expect((await readSegment(s.seg.path, io)).ok).toBe(true);
  });

  it('puts the old bytes back when the rewritten object does not read back, and removes nothing', async () => {
    const s = await segmentOf(3);
    const before = s.objects.files.get(s.seg.path)!;
    let reads = 0;
    const faulty: SegmentObjects = {
      put: s.objects.put,
      async get(path) {
        reads++;
        // The first read is of the object as it is; the second is the read-back.
        if (reads === 2) return new TextEncoder().encode('{"format":"other"}');
        return s.objects.get(path);
      },
    };
    const r = await dropFromSegment(s.seg.path, [2], { objects: faulty, codec: plainCodec });
    expect(r).toMatchObject({ ok: false, status: 'unavailable' });
    expect(s.objects.files.get(s.seg.path)).toEqual(before);
  });

  it('answers unavailable and changes nothing when the object is missing, cannot be decoded or cannot be written', async () => {
    const s = await segmentOf(3);
    const before = s.objects.files.get(s.seg.path)!;
    expect(
      await dropFromSegment('segments/9-9.payloads.zst', [9], {
        objects: s.objects,
        codec: plainCodec,
      }),
    ).toMatchObject({ ok: false, status: 'unavailable' });
    const junk = memoryObjects();
    await junk.put(s.seg.path, new TextEncoder().encode('not a segment'));
    expect(
      await dropFromSegment(s.seg.path, [1], { objects: junk, codec: plainCodec }),
    ).toMatchObject({ ok: false, status: 'unavailable' });
    const readOnly: SegmentObjects = {
      async put() {
        throw new Error('put failed');
      },
      get: s.objects.get,
    };
    expect(
      await dropFromSegment(s.seg.path, [1], { objects: readOnly, codec: plainCodec }),
    ).toMatchObject({ ok: false, status: 'unavailable' });
    expect(s.objects.files.get(s.seg.path)).toEqual(before);
  });

  it('never loses or changes a payload that is not in the list, whatever is removed (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }),
        fc.array(fc.integer({ min: 0, max: 12 }), { maxLength: 12 }),
        async (count, drop) => {
          const s = await segmentOf(count);
          const io = { objects: s.objects, codec: plainCodec };
          const r = await dropFromSegment(s.seg.path, drop, io);
          if (!r.ok) throw new Error(r.reason);
          const expected = [...s.payloads.keys()].filter((seq) => !drop.includes(seq));
          expect(r.remaining).toBe(r.removed.length === 0 ? count : expected.length);
          expect(r.removed).toEqual([...s.payloads.keys()].filter((seq) => drop.includes(seq)));
          if (!r.written) return;
          const got = await coldPayloads(
            s.hashes,
            [{ fromSeq: s.seg.fromSeq, toSeq: s.seg.toSeq, path: s.seg.path }],
            io,
          );
          if (!got.ok) throw new Error(got.reason);
          expect([...got.payloads.keys()]).toEqual(expected);
          for (const seq of expected) expect(got.payloads.get(seq)).toEqual(s.payloads.get(seq));
          expect(got.absent).toEqual(r.removed);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('segment names do not depend on the codec (HIS-029)', () => {
  it('hands the codec the canonical text, so a segment is stable for the same payloads', async () => {
    const seen: string[] = [];
    const codec: SegmentCodec = {
      async encode(text) {
        seen.push(text);
        return plainCodec.encode(text);
      },
      decode: plainCodec.decode,
    };
    const { candidates, payloads } = await candidatesOf([OLD]);
    const plan = coldMovePlan(candidates, { now: NOW });
    if (!plan.ok) throw new Error('plan refused');
    const io: ColdIo = { hot: memoryHot(payloads), objects: memoryObjects(), codec };
    await moveSegment(plan.segments[0]!, io);
    expect(seen).toHaveLength(1);
    expect(JSON.parse(seen[0]!).format).toBe('docedit-payload-segment/1');
  });
});
