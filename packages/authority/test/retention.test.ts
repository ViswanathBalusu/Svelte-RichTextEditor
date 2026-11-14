// The purge decision for workflow evidence (12 §7, §14; FRW-043 criteria 2 and 4, decision level).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { planPurge, type EvidenceRow } from '../src/workflow/retention.ts';

const row = fc.record({
  id: fc.stringMatching(/^ev_[a-z0-9]{1,8}$/),
  collectedAtMs: fc.integer({ min: 0, max: 2_000_000_000 }),
});
const rows = fc.uniqueArray(row, { selector: (r) => r.id, maxLength: 30 });

describe('the purge keeps evidence under a legal hold (FRW-043 criterion 2)', () => {
  it('removes nothing while the hold is on, however old the evidence (property)', () => {
    fc.assert(
      fc.property(
        rows,
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 0, max: 3_000_000_000 }),
        (rs, retentionMs, nowMs) => {
          const plan = planPurge({ rows: rs, nowMs, retentionMs, legalHold: true });
          expect(plan.remove).toEqual([]);
          expect(plan.keep).toEqual(rs.map((r) => r.id));
          expect(plan.audit.legalHold).toBe(true);
        },
      ),
    );
  });
});

describe('the purge removes evidence only after its retention (FRW-043 criterion 1, decision level)', () => {
  it('removes a row exactly when its retention has passed, and keeps a partition (property)', () => {
    fc.assert(
      fc.property(
        rows,
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 0, max: 3_000_000_000 }),
        (rs, retentionMs, nowMs) => {
          const plan = planPurge({ rows: rs, nowMs, retentionMs, legalHold: false });
          const expired = new Set(
            rs.filter((r) => nowMs - r.collectedAtMs >= retentionMs).map((r) => r.id),
          );
          expect(new Set(plan.remove)).toEqual(expired);
          expect(plan.remove.length + plan.keep.length).toBe(rs.length);
          for (const id of plan.keep) expect(expired.has(id)).toBe(false);
        },
      ),
    );
  });

  it('keeps a row one millisecond before its retention ends and removes it at the boundary', () => {
    const rs: EvidenceRow[] = [{ id: 'ev_a', collectedAtMs: 1000 }];
    expect(
      planPurge({ rows: rs, nowMs: 1999, retentionMs: 1000, legalHold: false }).remove,
    ).toEqual([]);
    expect(
      planPurge({ rows: rs, nowMs: 2000, retentionMs: 1000, legalHold: false }).remove,
    ).toEqual(['ev_a']);
  });
});

describe('the purge audit names counts and the instant, never a row (FRW-043 criterion 4)', () => {
  it('records the counts, the instant and the hold, with no identifier and no personal data', () => {
    const rs: EvidenceRow[] = [
      { id: 'ev_jane_doe_1', collectedAtMs: 0 },
      { id: 'ev_jane_doe_2', collectedAtMs: 900 },
    ];
    const plan = planPurge({ rows: rs, nowMs: 1000, retentionMs: 500, legalHold: false });
    expect(plan.audit).toEqual({
      kind: 'evidence.purge',
      atMs: 1000,
      removedCount: 1,
      keptCount: 1,
      legalHold: false,
    });
    expect(JSON.stringify(plan.audit)).not.toContain('jane');
  });
});

describe('the purge refuses inputs it cannot reason about', () => {
  it('throws for a non-positive or non-integer retention and a bad clock', () => {
    const rs: EvidenceRow[] = [];
    expect(() => planPurge({ rows: rs, nowMs: 1, retentionMs: 0, legalHold: false })).toThrow(
      RangeError,
    );
    expect(() => planPurge({ rows: rs, nowMs: 1, retentionMs: 1.5, legalHold: false })).toThrow(
      RangeError,
    );
    expect(() => planPurge({ rows: rs, nowMs: -1, retentionMs: 1, legalHold: false })).toThrow(
      RangeError,
    );
  });
});
