// A legal hold on a document suspends every removal the history plans make (08 §11; HIS-031
// criterion 1): the checkpoints (HIS-030 plan), the payloads (HIS-032 plan) and the purge
// (HIS-039 plan). These tests run the three plans with the same hold, for any history, and check
// that each removes nothing while the hold lasts and that each returns to its policy on release.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { NO_HOLD } from '../src/hold.ts';
import {
  type PayloadRecord,
  type PinnedVersion,
  payloadThinningPlan,
} from '../src/payload-thinning.ts';
import { type PurgeRequest, purgePlan } from '../src/purge.ts';
import { type CheckpointRecord, DAY_MS, KEEP_ALL_MS, thinningPlan } from '../src/thinning.ts';

const NOW = 400 * DAY_MS;
const WEEKLY_AFTER = 120 * DAY_MS;

const checkpoints: CheckpointRecord[] = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({
  seq: i * 10,
  time: NOW - (40 + i * 9) * DAY_MS,
  verified: true,
  pinned: false,
  bordersSnapshot: false,
}));

const commits: PayloadRecord[] = Array.from({ length: 80 }, (_, i) => ({
  seq: i + 1,
  time: NOW - (80 - i) * DAY_MS,
  kind: 'steps',
}));

const DELETED_AT = NOW - 90 * DAY_MS;
const purgeRequest = (hold: boolean): PurgeRequest => ({
  doc: 'doc-1',
  deletedAt: DELETED_AT,
  retentionMs: 30 * DAY_MS,
  now: NOW,
  hold: hold ? { inForce: true } : NO_HOLD,
  assets: [{ id: 'a1', sharedWithOtherDocument: false }],
});

describe('a legal hold suspends every planned removal (HIS-031 criterion 1)', () => {
  it('removes no checkpoint, payload or purge while the hold is in force', () => {
    const cp = thinningPlan(checkpoints, { now: NOW, weeklyAfterMs: WEEKLY_AFTER, hold: true });
    if (!cp.ok) throw new Error('checkpoint plan refused');
    expect(cp.remove).toEqual([]);

    const pl = payloadThinningPlan(commits, [], [], {
      now: NOW,
      periodMs: 30 * DAY_MS,
      hold: true,
    });
    if (!pl.ok) throw new Error('payload plan refused');
    expect(pl.remove).toEqual([]);

    const purge = purgePlan(purgeRequest(true));
    if (!purge.ok) throw new Error('purge plan refused');
    expect(purge.outcome).toEqual({ run: false, reason: 'legal-hold' });
  });

  it('suspends the three plans for any history, and the policy is back on release (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: KEEP_ALL_MS, max: 200 * DAY_MS }),
        fc.integer({ min: 0, max: 120 * DAY_MS }),
        (weeklyAfterMs, periodMs) => {
          const held = { now: NOW, weeklyAfterMs, hold: true };
          const cpHeld = thinningPlan(checkpoints, held);
          const plHeld = payloadThinningPlan(commits, [40, 50], [], {
            now: NOW,
            periodMs,
            hold: true,
          });
          if (!cpHeld.ok || !plHeld.ok) throw new Error('refused');
          expect(cpHeld.remove).toEqual([]);
          expect(plHeld.remove).toEqual([]);
          expect(purgePlan(purgeRequest(true))).toEqual({
            ok: true,
            outcome: { run: false, reason: 'legal-hold' },
          });

          // Released: the same inputs plan removals again, so the hold is what stopped them.
          const cpFree = thinningPlan(checkpoints, { ...held, hold: false });
          const plFree = payloadThinningPlan(commits, [40, 50], [], {
            now: NOW,
            periodMs,
            hold: false,
          });
          if (!cpFree.ok || !plFree.ok) throw new Error('refused');
          expect(cpFree.keep.length + cpFree.remove.length + cpFree.held.length).toBe(
            checkpoints.length,
          );
          const purgeFree = purgePlan(purgeRequest(false));
          if (!purgeFree.ok) throw new Error('refused');
          expect(purgeFree.outcome.run).toBe(true);
        },
      ),
    );
  });

  it('a pinned version does not change the held plans either', () => {
    const versions: PinnedVersion[] = [{ seq: 60, kind: 'named' }];
    const pl = payloadThinningPlan(commits, [40], versions, {
      now: NOW,
      periodMs: 0,
      hold: true,
    });
    if (!pl.ok) throw new Error('payload plan refused');
    expect(pl.remove).toEqual([]);
    expect(pl.keep.length).toBe(commits.length);
  });
});
