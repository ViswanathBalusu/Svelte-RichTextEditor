// Thinning old checkpoints (08 §11; HIS-030 criterion 2 and the rule behind criterion 1): younger
// than 30 days all kept; older, one per day, then one per week; pinned, snapshot-bordering and
// unverified-keeper periods are never removed.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type CheckpointRecord,
  DAY_MS,
  KEEP_ALL_MS,
  WEEK_MS,
  thinningPlan,
} from '../src/thinning.ts';

const NOW = 400 * DAY_MS;
// Test data only: the spec does not give the day-to-week boundary (HIS-030 notes, open).
const WEEKLY_AFTER = 120 * DAY_MS;

const cp = (seq: number, time: number, over: Partial<CheckpointRecord> = {}): CheckpointRecord => ({
  seq,
  time,
  verified: true,
  pinned: false,
  bordersSnapshot: false,
  ...over,
});

const policy = { now: NOW, weeklyAfterMs: WEEKLY_AFTER };

describe('thinning checkpoints with age (HIS-030)', () => {
  it('keeps every checkpoint younger than 30 days (criterion 1)', () => {
    const young = [0, 1, 2, 3].map((i) => cp(i + 1, NOW - i * 3 * 60 * 60 * 1000));
    const r = thinningPlan(young, policy);
    expect(r).toEqual({ ok: true, keep: [1, 2, 3, 4], remove: [], held: [] });
  });

  it('thins the older ones to one per day, then to one per week past the boundary (criterion 1)', () => {
    const day = (d: number) => NOW - d * DAY_MS;
    // Three checkpoints on each of two days, 40 days ago: one per day is kept, the highest seq.
    const dayA = [cp(1, day(40)), cp(2, day(40) + 60_000), cp(3, day(40) + 120_000)];
    const dayB = [cp(4, day(41)), cp(5, day(41) + 1_000)];
    const r = thinningPlan([...dayA, ...dayB], policy);
    if (!r.ok) throw new Error('refused');
    expect(r.keep).toEqual([3, 5]);
    expect(r.remove).toEqual([1, 2, 4]);
    // Far older than the weekly boundary, every checkpoint in one epoch week collapses to one.
    const old = [0, 1, 2].map((i) => cp(10 + i, WEEK_MS * 2 + i * DAY_MS));
    const w = thinningPlan(old, policy);
    if (!w.ok) throw new Error('refused');
    expect(w.keep).toEqual([12]);
    expect(w.remove).toEqual([10, 11]);
  });

  it('never removes a checkpoint a version points at, or one that borders a snapshot (criterion 2)', () => {
    const day = (d: number) => NOW - d * DAY_MS;
    const set = [
      cp(1, day(50), { pinned: true }),
      cp(2, day(50) + 1_000),
      cp(3, day(50) + 2_000, { bordersSnapshot: true }),
      cp(4, day(50) + 3_000),
    ];
    const r = thinningPlan(set, policy);
    if (!r.ok) throw new Error('refused');
    expect(r.keep).toEqual([1, 3, 4]);
    expect(r.remove).toEqual([2]);
    for (const seq of [1, 3]) expect(r.remove).not.toContain(seq);
  });

  it('holds back a period whose kept checkpoint is not verified against a replay (criterion 3, the rule)', () => {
    const day = (d: number) => NOW - d * DAY_MS;
    const set = [cp(1, day(60)), cp(2, day(60) + 1_000, { verified: false })];
    const r = thinningPlan(set, policy);
    if (!r.ok) throw new Error('refused');
    expect(r.remove).toEqual([]);
    expect(r.held).toEqual([1, 2]);
  });

  it('refuses a weekly boundary below 30 days', () => {
    expect(thinningPlan([], { now: NOW, weeklyAfterMs: KEEP_ALL_MS - 1 })).toMatchObject({
      ok: false,
      code: 'validation_failed',
    });
  });

  it('partitions the checkpoints and keeps at least one per period (property)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            seq: fc.integer({ min: 1, max: 500 }),
            age: fc.integer({ min: 0, max: 400 * DAY_MS }),
            verified: fc.boolean(),
            pinned: fc.boolean(),
            bordersSnapshot: fc.boolean(),
          }),
          { maxLength: 40 },
        ),
        (items) => {
          const seen = new Set<number>();
          const records: CheckpointRecord[] = [];
          for (const item of items) {
            if (seen.has(item.seq)) continue;
            seen.add(item.seq);
            records.push(cp(item.seq, NOW - item.age, item));
          }
          const r = thinningPlan(records, policy);
          if (!r.ok) throw new Error('refused');
          const all = [...r.keep, ...r.remove, ...r.held].sort((a, b) => a - b);
          expect(all).toEqual([...seen].sort((a, b) => a - b));
          // Nothing protected is removed.
          for (const c of records)
            if (c.pinned || c.bordersSnapshot || NOW - c.time < KEEP_ALL_MS)
              expect(r.remove).not.toContain(c.seq);
        },
      ),
    );
  });
});
