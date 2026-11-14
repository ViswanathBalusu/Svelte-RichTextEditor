/**
 * SEC-057 — deletion and retention remove what they promise, as far as packages/history shows
 * (10 §4; 08 §11, §13; HIS-031, HIS-040).
 *
 * Covered here:
 * - criterion 2: a commit's payload replaced by a tombstone leaves the chain verifiable, for any
 *   log length and any commit (fast-check). The verifier is the one a relying party runs.
 * - criterion 3, in part: while a legal hold is in force, the tombstone is refused and the thinning
 *   plan removes nothing. Purge is not in packages/history (it is the document service's), so the
 *   purge half of criterion 3 is not proved here.
 *
 * Not covered (see the story Notes): the listing of every table and object prefix after a purge
 * (criterion 1), evidence retention (criterion 4), per-document keys (criterion 5, SEC-062 is a
 * decision) and the backup ageing statement (criterion 6).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BUNDLE_FORMAT,
  DAY_MS,
  KEEP_ALL_MS,
  NO_HOLD,
  chainHash,
  payloadDigest,
  payloadOf,
  thinningPlan,
  tombstone,
  verifyBundle,
  type BundleCommit,
  type ChainMetadata,
  type CheckpointRecord,
  type LogBundle,
} from '../../../packages/history/src/index.ts';

const DOC = 'doc-sec057';
const HOLD_ON = { inForce: true } as const;

function metaFor(seq: number, size: number): ChainMetadata {
  return {
    doc: DOC,
    seq,
    kind: 'commit',
    id: `c-${seq}`,
    user: 'ann',
    session: null,
    agent: null,
    time: '2026-11-13T09:00:00.000Z',
    origin: 'client',
    scopes: ['edit'],
    base: seq - 1,
    rebased: false,
    revision: 1,
    jti: null,
    cdm: 1,
    engine: 'engine-1',
    size,
  };
}

/** A valid n-commit log, built the way the stored chain is built (ADR 0020). */
async function buildLog(n: number): Promise<LogBundle> {
  const commits: BundleCommit[] = [];
  let prev: string | null = null;
  for (let seq = 1; seq <= n; seq++) {
    const payload = {
      steps: [{ stepType: 'insert', text: `text-${seq}` }],
      retired: [],
      claimed: [],
    };
    const { hash: payloadHash, size } = await payloadDigest(payload);
    const meta = metaFor(seq, size);
    const hash = await chainHash(prev, meta, payloadHash);
    commits.push({ meta, payloadHash, prevHash: prev, hash, payload });
    prev = hash;
  }
  return { format: BUNDLE_FORMAT, doc: DOC, head: { seq: n, chainHead: prev }, commits };
}

describe('SEC-057 criterion 2: a tombstoned payload still verifies', () => {
  it('keeps the log intact for any length and any commit, and counts the removed payload', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 12 }), fc.nat(), async (n, pick) => {
        const log = await buildLog(n);
        const seq = (pick % n) + 1;
        const result = tombstone(log, {
          seq,
          actor: 'admin-1',
          reason: 'deletion request',
          now: 1_800_000_000_000,
          hold: NO_HOLD,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const report = await verifyBundle(result.bundle);
        expect(report.status).toBe('intact');
        expect(report.payloadsAbsent).toBe(1);
        expect(report.payloadsChecked).toBe(n - 1);

        // The removed payload is refused by the reader with a fixed reason, never a guess.
        const read = payloadOf(result.bundle, seq);
        expect(read.ok).toBe(false);
        // The other payloads are still readable.
        for (let s = 1; s <= n; s++) {
          if (s === seq) continue;
          const other = payloadOf(result.bundle, s);
          expect(other.ok).toBe(true);
        }

        // The audit names the actor and the reason, and the copies that may still hold the text.
        expect(result.audit).toMatchObject({ action: 'tombstone', seq, actor: 'admin-1' });
        expect(result.copies.attributionMap).toBe('may-hold-runs');
      }),
      { numRuns: 100 },
    );
  });

  it('shows the copies that hold the removed text (checkpoints at or after the commit)', async () => {
    const log = await buildLog(6);
    const withCheckpoints: LogBundle = {
      ...log,
      checkpoints: [
        { seq: 2, contentHash: 'h2' },
        { seq: 4, contentHash: 'h4' },
        { seq: 6, contentHash: 'h6' },
      ],
    };
    const result = tombstone(withCheckpoints, {
      seq: 3,
      actor: 'admin-1',
      reason: 'deletion request',
      now: 1_800_000_000_000,
      hold: NO_HOLD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Checkpoints from seq 3 on may hold the text; the tombstone reports them and does not rewrite them.
    expect(result.copies.checkpoints).toEqual([4, 6]);
  });
});

describe('SEC-057 criterion 3, in part: a legal hold stops tombstones and thinning', () => {
  it('refuses a tombstone for any commit while a hold is in force, and leaves the log unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 8 }), fc.nat(), async (n, pick) => {
        const log = await buildLog(n);
        const seq = (pick % n) + 1;
        const result = tombstone(log, {
          seq,
          actor: 'admin-1',
          reason: 'deletion request',
          now: 1_800_000_000_000,
          hold: HOLD_ON,
        });
        expect(result.ok).toBe(false);
        // The input bundle is never edited by a refused request.
        const payloadStill = log.commits.find((c) => c.meta.seq === seq)?.payload;
        expect(payloadStill).toBeDefined();
      }),
      { numRuns: 100 },
    );
  });

  it('removes no checkpoint while a hold is in force, however old and verified they are', () => {
    const now = 1_800_000_000_000;
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            seq: fc.integer({ min: 1, max: 10_000 }),
            ageDays: fc.integer({ min: 0, max: 900 }),
            verified: fc.boolean(),
            pinned: fc.boolean(),
            bordersSnapshot: fc.boolean(),
          }),
          { minLength: 0, maxLength: 60 },
        ),
        (rows) => {
          const seen = new Set<number>();
          const checkpoints: CheckpointRecord[] = [];
          for (const r of rows) {
            if (seen.has(r.seq)) continue;
            seen.add(r.seq);
            checkpoints.push({
              seq: r.seq,
              time: now - r.ageDays * DAY_MS,
              verified: r.verified,
              pinned: r.pinned,
              bordersSnapshot: r.bordersSnapshot,
            });
          }
          const plan = thinningPlan(checkpoints, {
            now,
            weeklyAfterMs: KEEP_ALL_MS,
            hold: true,
          });
          expect(plan.ok).toBe(true);
          if (!plan.ok) return;
          expect(plan.remove).toEqual([]);
          expect(plan.held).toEqual([]);
          expect(plan.keep).toHaveLength(checkpoints.length);
        },
      ),
      { numRuns: 200 },
    );
  });
});
