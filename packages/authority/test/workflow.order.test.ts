// Activating participants in order (FRW-031 criteria 1, 3, 5 and 6, the state parts). Pure functions.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { WorkflowParticipant, WorkflowRecord } from '../src/workflow/lifecycle.ts';
import {
  activeParticipantIds,
  completeParticipant,
  fillActive,
  hasPendingParticipants,
} from '../src/workflow/order.ts';
import { sendWorkflow } from '../src/workflow/send.ts';

const HEAD = { seq: 7, hash: 'b'.repeat(64) };
const OWNER = { manage: true };

const p = (
  id: string,
  order: number,
  kind: WorkflowParticipant['kind'] = 'filler',
  completed = false,
): WorkflowParticipant => ({ id, roles: [`role-${id}`], kind, order, completed });

function sentRecord(participants: WorkflowParticipant[]): WorkflowRecord {
  const draft: WorkflowRecord = {
    state: 'draft',
    participants,
    sentSeq: null,
    sentHash: null,
    end: null,
  };
  // A draft with no fields and no roles passes the checklist, so the send activates the order.
  const result = sendWorkflow(draft, OWNER, { type: 'doc', content: [] }, HEAD);
  if (!result.ok) throw new Error('the empty draft must send');
  return result.record;
}

const kindArb = fc.constantFrom<WorkflowParticipant['kind']>('filler', 'signer', 'approver', 'cc');
const participantsArb = fc
  .array(
    fc.record({ kind: kindArb, order: fc.integer({ min: 1, max: 3 }), completed: fc.boolean() }),
    { minLength: 1, maxLength: 6 },
  )
  .map((rows) => rows.map((r, i) => p(`p${i}`, r.order, r.kind, r.completed)));

describe('only the lowest order is active when the workflow is sent (FRW-031 criterion 1)', () => {
  it('activates order 1 and leaves order 2 unable to fill', () => {
    const record = sentRecord([p('first', 1), p('second', 2)]);
    expect(record.state).toBe('sent');
    expect(activeParticipantIds(record.participants)).toEqual(['first']);
    expect(fillActive(record, 'first')).toBe(true);
    expect(fillActive(record, 'second')).toBe(false);
  });

  it('activates only must-act participants of the lowest order (property)', () => {
    fc.assert(
      fc.property(participantsArb, (participants) => {
        const active = activeParticipantIds(participants);
        const pending = participants.filter((x) => x.kind !== 'cc' && !x.completed);
        const lowest = pending.length === 0 ? null : Math.min(...pending.map((x) => x.order));
        const expected = pending.filter((x) => x.order === lowest).map((x) => x.id);
        expect([...active].sort()).toEqual([...expected].sort());
        for (const id of active) {
          const who = participants.find((x) => x.id === id);
          expect(who?.kind).not.toBe('cc');
        }
      }),
    );
  });
});

describe('participants of the same order are active together (FRW-031 criterion 3)', () => {
  it('lets either of two same-order participants complete first', () => {
    const record = sentRecord([p('a', 1), p('b', 1), p('c', 2)]);
    expect(activeParticipantIds(record.participants)).toEqual(['a', 'b']);
    const opened = { ...record, state: 'in_progress' as const };

    const first = completeParticipant(opened, 'b');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.completion.activated).toEqual([]);
    expect(first.completion.completedWorkflow).toBe(false);
    expect(activeParticipantIds(first.record.participants)).toEqual(['a']);

    const second = completeParticipant(first.record, 'a');
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.completion.activated).toEqual(['c']);
  });
});

describe('the next order is activated only when the lowest order is done (FRW-031 criterion 2, state part)', () => {
  it('moves on to the next order and never skips one (property)', () => {
    fc.assert(
      fc.property(participantsArb, (participants) => {
        const record: WorkflowRecord = {
          state: 'in_progress',
          participants,
          sentSeq: 1,
          sentHash: HEAD.hash,
          end: null,
        };
        const active = activeParticipantIds(participants);
        if (active.length === 0) return;
        const id = active[0]!;
        const result = completeParticipant(record, id);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const nextActive = activeParticipantIds(result.record.participants);
        // Every must-act participant still pending has an order not below any newly active one.
        const pendingOrders = result.record.participants
          .filter((x) => x.kind !== 'cc' && !x.completed)
          .map((x) => x.order);
        for (const nid of nextActive) {
          const order = result.record.participants.find((x) => x.id === nid)!.order;
          expect(Math.min(...pendingOrders)).toBe(order);
        }
        expect(result.completion.completedWorkflow).toBe(
          !hasPendingParticipants(result.record.participants),
        );
      }),
    );
  });
});

describe('the last participant who must act completes the workflow (FRW-031 criterion 5 and 6)', () => {
  it('completes the workflow when the last must-act participant completes; cc does not block it', () => {
    const record: WorkflowRecord = {
      state: 'in_progress',
      participants: [p('filler', 1), p('observer', 1, 'cc')],
      sentSeq: 1,
      sentHash: HEAD.hash,
      end: null,
    };
    const result = completeParticipant(record, 'filler');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.state).toBe('completed');
    expect(result.completion.completedWorkflow).toBe(true);
  });

  it('moves a two-step workflow to completed only after the approver completes', () => {
    const record = sentRecord([p('signer', 1, 'signer'), p('approver', 2, 'approver')]);
    const opened = { ...record, state: 'in_progress' as const };
    const one = completeParticipant(opened, 'signer');
    expect(one.ok && one.completion.activated).toEqual(['approver']);
    if (!one.ok) return;
    expect(one.record.state).toBe('in_progress');
    const two = completeParticipant(one.record, 'approver');
    expect(two.ok && two.record.state).toBe('completed');
  });

  it('refuses a completion by a participant who is not active, or outside in_progress', () => {
    const record = sentRecord([p('first', 1), p('second', 2)]);
    expect(completeParticipant(record, 'second')).toEqual({ ok: false, refusal: 'invalid_state' });
    const opened = { ...record, state: 'in_progress' as const };
    expect(completeParticipant(opened, 'second')).toEqual({ ok: false, refusal: 'forbidden' });
  });

  it('gives a cc participant no fill capability (criterion 5, the cc part)', () => {
    const record = sentRecord([p('filler', 1), p('copy', 1, 'cc')]);
    expect(fillActive(record, 'copy')).toBe(false);
    expect(fillActive({ ...record, state: 'in_progress' }, 'copy')).toBe(false);
  });
});
