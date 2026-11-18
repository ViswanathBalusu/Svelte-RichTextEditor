// Legal holds (08 §11; 13 §10; HIS-031): a hold suspends thinning while it lasts; releasing it
// returns to the policy with nothing thinned retroactively; each change is audited with the actor
// and the time; a change that does not change the state, or names no actor or reason, is refused.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { NO_HOLD, applyHold } from '../src/hold.ts';
import { type CheckpointRecord, DAY_MS, thinningPlan } from '../src/thinning.ts';

const NOW = 400 * DAY_MS;
const WEEKLY_AFTER = 120 * DAY_MS;

const cps: CheckpointRecord[] = [1, 2, 3, 4, 5, 6].map((i) => ({
  seq: i,
  time: NOW - (60 + Math.floor(i / 2)) * DAY_MS - i * 1000,
  verified: true,
  pinned: false,
  bordersSnapshot: false,
}));

describe('legal holds (HIS-031)', () => {
  it('suspends thinning while a hold is in force, and resumes the policy after release (criteria 1, 3)', () => {
    const set = applyHold(NO_HOLD, {
      action: 'set',
      actor: 'admin-1',
      reason: 'dispute',
      now: NOW,
    });
    if (!set.ok) throw new Error(set.reason);
    const during = thinningPlan(cps, { now: NOW, weeklyAfterMs: WEEKLY_AFTER, hold: true });
    expect(during).toEqual({
      ok: true,
      keep: [1, 2, 3, 4, 5, 6],
      remove: [],
      held: [],
      keepers: [],
    });

    const released = applyHold(set.state, {
      action: 'release',
      actor: 'admin-1',
      reason: 'dispute closed',
      now: NOW + 1,
    });
    if (!released.ok) throw new Error(released.reason);
    const after = thinningPlan(cps, { now: NOW, weeklyAfterMs: WEEKLY_AFTER, hold: false });
    const never = thinningPlan(cps, { now: NOW, weeklyAfterMs: WEEKLY_AFTER });
    // Released, the plan is the policy's own: nothing is thinned beyond what the policy allows.
    expect(after).toEqual(never);
    if (!after.ok) throw new Error('refused');
    expect(after.remove.length).toBeGreaterThan(0);
  });

  it('plans no removal under a hold, for any checkpoints, and the policy plan after it (property)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            age: fc.integer({ min: 0, max: 400 }),
            verified: fc.boolean(),
            pinned: fc.boolean(),
            bordersSnapshot: fc.boolean(),
          }),
          { maxLength: 30 },
        ),
        (rows) => {
          const list: CheckpointRecord[] = rows.map((r, i) => ({
            seq: i + 1,
            time: NOW - r.age * DAY_MS - i * 1000,
            verified: r.verified,
            pinned: r.pinned,
            bordersSnapshot: r.bordersSnapshot,
          }));
          const held = thinningPlan(list, { now: NOW, weeklyAfterMs: WEEKLY_AFTER, hold: true });
          const policy = thinningPlan(list, { now: NOW, weeklyAfterMs: WEEKLY_AFTER });
          const released = thinningPlan(list, {
            now: NOW,
            weeklyAfterMs: WEEKLY_AFTER,
            hold: false,
          });
          if (!held.ok || !policy.ok || !released.ok) throw new Error('refused');
          expect(held.remove).toEqual([]);
          expect(held.keep).toEqual(list.map((c) => c.seq));
          expect(released).toEqual(policy);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('audits each set and release with the actor, the reason and the time (criterion 4, audit part)', () => {
    const set = applyHold(NO_HOLD, {
      action: 'set',
      actor: 'admin-1',
      reason: 'dispute',
      now: NOW,
    });
    expect(set).toMatchObject({
      ok: true,
      state: { inForce: true },
      audit: { action: 'hold-set', actor: 'admin-1', reason: 'dispute', at: NOW },
    });
    if (!set.ok) throw new Error('refused');
    const rel = applyHold(set.state, {
      action: 'release',
      actor: 'admin-2',
      reason: 'closed',
      now: NOW + 5,
    });
    expect(rel).toMatchObject({
      ok: true,
      state: { inForce: false },
      audit: { action: 'hold-released', actor: 'admin-2', reason: 'closed', at: NOW + 5 },
    });
  });

  it('refuses a change that does not change the state, or that names no actor or reason', () => {
    const base = { actor: 'admin-1', reason: 'dispute', now: NOW };
    expect(applyHold(NO_HOLD, { action: 'release', ...base })).toMatchObject({
      ok: false,
      code: 'conflict',
    });
    const set = applyHold(NO_HOLD, { action: 'set', ...base });
    if (!set.ok) throw new Error('refused');
    expect(applyHold(set.state, { action: 'set', ...base })).toMatchObject({
      ok: false,
      code: 'conflict',
    });
    expect(applyHold(NO_HOLD, { action: 'set', ...base, actor: ' ' })).toMatchObject({
      ok: false,
      code: 'validation_failed',
    });
    expect(applyHold(NO_HOLD, { action: 'set', ...base, reason: '' })).toMatchObject({
      ok: false,
      code: 'validation_failed',
    });
  });
});
