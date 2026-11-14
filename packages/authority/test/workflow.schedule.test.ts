// The deadline, the reminder schedule and `remind` (FRW-034 criteria 1 to 6, the state and timing
// parts). Pure functions; the scheduler, the events and the store are not built.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { WorkflowParticipant, WorkflowRecord } from '../src/workflow/lifecycle.ts';
import {
  DAY_MS,
  expireIfDue,
  newReminders,
  parseDeadline,
  reminderEligible,
  remindersDue,
  remindTargets,
} from '../src/workflow/schedule.ts';
import { fillActive } from '../src/workflow/order.ts';

const p = (
  id: string,
  order: number,
  kind: WorkflowParticipant['kind'] = 'filler',
  completed = false,
): WorkflowParticipant => ({ id, roles: [`role-${id}`], kind, order, completed });

const record = (
  state: WorkflowRecord['state'],
  participants: WorkflowParticipant[],
): WorkflowRecord => ({ state, participants, sentSeq: 7, sentHash: 'c'.repeat(64), end: null });

const POLICY = { firstAfterDays: 3, everyDays: 2 };
const MANAGER = { manage: true };
const CLERK = { manage: false };

describe('parseDeadline (criterion 6: the instant is read as UTC)', () => {
  it('reads the example of 12 §6.1 as the UTC instant', () => {
    expect(parseDeadline('2026-10-18T00:00:00Z')).toBe(Date.UTC(2026, 9, 18, 0, 0, 0));
  });

  it('reads a value with no suffix as UTC too, never as local time', () => {
    expect(parseDeadline('2026-10-18T09:30')).toBe(Date.UTC(2026, 9, 18, 9, 30));
    expect(parseDeadline('2026-10-18T09:30:15.5')).toBe(Date.UTC(2026, 9, 18, 9, 30, 15, 500));
  });

  it('refuses other offsets and calendar values that do not exist', () => {
    expect(parseDeadline('2026-10-18T00:00:00+02:00')).toBeNull();
    expect(parseDeadline('2026-02-30T00:00:00Z')).toBeNull();
    expect(parseDeadline('2026-13-01T00:00:00Z')).toBeNull();
    expect(parseDeadline('2026-10-18T24:00:00Z')).toBeNull();
    expect(parseDeadline('2026-10-18T23:59:60Z')).toBeNull();
    expect(parseDeadline('18/10/2026')).toBeNull();
  });

  it('round-trips every valid UTC instant it generates', () => {
    fc.assert(
      fc.property(
        fc.date({
          min: new Date('2000-01-01T00:00:00Z'),
          max: new Date('2099-12-31T23:59:59Z'),
          noInvalidDate: true,
        }),
        (d) => {
          const text = d.toISOString();
          expect(parseDeadline(text)).toBe(d.getTime());
        },
      ),
    );
  });
});

describe('remindersDue and newReminders (criteria 2 and 5)', () => {
  it('raises the first reminder after 3 days and then every 2 days (the example of the criterion)', () => {
    const anchor = 0;
    expect(remindersDue(anchor, 3 * DAY_MS - 1, POLICY)).toBe(0);
    expect(remindersDue(anchor, 3 * DAY_MS, POLICY)).toBe(1);
    expect(remindersDue(anchor, 5 * DAY_MS - 1, POLICY)).toBe(1);
    expect(remindersDue(anchor, 5 * DAY_MS, POLICY)).toBe(2);
    expect(remindersDue(anchor, 7 * DAY_MS, POLICY)).toBe(3);
  });

  it('is never decreasing as time passes', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 30 }),
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 0, max: 400 }),
        fc.integer({ min: 0, max: 400 }),
        (first, every, a, b) => {
          const pol = { firstAfterDays: first, everyDays: every };
          const lo = Math.min(a, b) * DAY_MS;
          const hi = Math.max(a, b) * DAY_MS;
          expect(remindersDue(0, lo, pol)).toBeLessThanOrEqual(remindersDue(0, hi, pol));
        },
      ),
    );
  });

  it('gives each reminder number once across any sequence of instants on any instance (criterion 5)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 120 }), { minLength: 1, maxLength: 12 }),
        (days) => {
          const instants = [...days].sort((x, y) => x - y).map((d) => d * DAY_MS);
          let raised = 0;
          const all: number[] = [];
          for (const now of instants) {
            const fresh = newReminders(0, now, POLICY, raised);
            all.push(...fresh);
            raised += fresh.length;
            // A second instance reading the same stored count at the same instant gets nothing new.
            expect(newReminders(0, now, POLICY, raised)).toEqual([]);
          }
          expect(all).toEqual(Array.from({ length: all.length }, (_, i) => i + 1));
          const last = instants[instants.length - 1] ?? 0;
          expect(all.length).toBe(remindersDue(0, last, POLICY));
        },
      ),
    );
  });

  it('refuses a policy that is not usable or a raised count that is not a count', () => {
    expect(() => remindersDue(0, DAY_MS, { firstAfterDays: -1, everyDays: 2 })).toThrow(RangeError);
    expect(() => remindersDue(0, DAY_MS, { firstAfterDays: 3, everyDays: 0 })).toThrow(RangeError);
    expect(() => newReminders(0, DAY_MS, POLICY, -1)).toThrow(RangeError);
  });
});

describe('remind and reminder eligibility (criteria 3 and 4)', () => {
  it('raises for the active participants who have not completed, for a caller with manage', () => {
    const r = record('in_progress', [p('a', 1), p('b', 1), p('c', 2), p('d', 1, 'filler', true)]);
    expect(remindTargets(r, MANAGER)).toEqual({ ok: true, participantIds: ['a', 'b'] });
  });

  it('refuses a caller without manage with forbidden, and a stopped or draft workflow with invalid_state', () => {
    const r = record('in_progress', [p('a', 1)]);
    expect(remindTargets(r, CLERK)).toEqual({ ok: false, refusal: 'forbidden' });
    expect(remindTargets(record('draft', [p('a', 1)]), MANAGER)).toEqual({
      ok: false,
      refusal: 'invalid_state',
    });
  });

  it('gives no further reminder to a completed participant, nor in a terminal state', () => {
    const done = record('in_progress', [p('a', 1, 'filler', true), p('b', 1)]);
    expect(reminderEligible(done, 'a')).toBe(false);
    expect(reminderEligible(done, 'b')).toBe(true);
    for (const state of ['completed', 'finalised', 'expired', 'declined', 'voided'] as const) {
      expect(reminderEligible(record(state, [p('a', 1)]), 'a')).toBe(false);
    }
  });

  it('never raises for a copy participant or for an unknown identifier', () => {
    const r = record('sent', [p('a', 1), p('cc', 1, 'cc')]);
    expect(reminderEligible(r, 'cc')).toBe(false);
    expect(reminderEligible(r, 'nobody')).toBe(false);
  });

  it('gives a participant no reminder while the workflow is correcting', () => {
    expect(reminderEligible(record('correcting', [p('a', 1)]), 'a')).toBe(false);
  });
});

describe('expireIfDue (criterion 1, the state part)', () => {
  const deadline = Date.UTC(2026, 9, 18);

  it('expires a running workflow at the deadline and not before', () => {
    const r = record('sent', [p('a', 1)]);
    expect(expireIfDue(r, deadline, deadline - 1)).toEqual({ ok: false, refusal: 'not_due' });
    const at = expireIfDue(r, deadline, deadline);
    expect(at.ok).toBe(true);
    if (at.ok) {
      expect(at.record.state).toBe('expired');
      expect(at.record.end).toBeNull();
    }
  });

  it('refuses expiry of a workflow that is not running', () => {
    expect(expireIfDue(record('draft', [p('a', 1)]), deadline, deadline + 1)).toEqual({
      ok: false,
      refusal: 'invalid_state',
    });
    expect(expireIfDue(record('completed', [p('a', 1)]), deadline, deadline + 1)).toEqual({
      ok: false,
      refusal: 'invalid_state',
    });
  });

  it('stops every participant from filling once the workflow has expired', () => {
    fc.assert(
      fc.property(fc.constantFrom('sent', 'in_progress'), (state) => {
        const r = record(state, [p('a', 1)]);
        expect(fillActive(r, 'a')).toBe(true);
        const expired = expireIfDue(r, deadline, deadline);
        expect(expired.ok).toBe(true);
        if (expired.ok) expect(fillActive(expired.record, 'a')).toBe(false);
      }),
    );
  });
});
