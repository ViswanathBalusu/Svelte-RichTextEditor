// Correcting and resuming a workflow (FRW-032 criteria 1, 3, 4, 5, 6 and 7, the state and reset
// parts). Pure functions; the endpoints, the control commit, the event and the recovered edits are
// not built.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { WorkflowParticipant, WorkflowRecord } from '../src/workflow/lifecycle.ts';
import {
  compareWithSent,
  correctWorkflow,
  resumeWorkflow,
  type DocumentSnapshot,
} from '../src/workflow/correction.ts';
import { fillActive } from '../src/workflow/order.ts';

const p = (
  id: string,
  order: number,
  kind: WorkflowParticipant['kind'] = 'signer',
  completed = false,
): WorkflowParticipant => ({ id, roles: [`role-${id}`], kind, order, completed });

const record = (
  state: WorkflowRecord['state'],
  participants: WorkflowParticipant[],
): WorkflowRecord => ({ state, participants, sentSeq: 7, sentHash: 'd'.repeat(64), end: null });

const MANAGER = { manage: true };
const CLERK = { manage: false };
const SENT: DocumentSnapshot = {
  body: 'Lease for unit 4.',
  fields: { 'lease.total': '1200', 'tenant.name': 'Ann' },
};
const OWNERS = { 'lease.total': 'landlord', 'tenant.name': 'tenant' };

describe('correct (criterion 1, the state part)', () => {
  it('moves an in_progress workflow to correcting for a caller with manage, and pauses every participant', () => {
    const r = record('in_progress', [p('tenant', 1), p('landlord', 2)]);
    const out = correctWorkflow(r, MANAGER);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.record.state).toBe('correcting');
    // Paused: no participant may fill while the workflow is correcting (criterion 2, the gate part).
    expect(fillActive(out.record, 'tenant')).toBe(false);
    expect(fillActive(out.record, 'landlord')).toBe(false);
  });

  it('refuses a caller without manage with forbidden, and any state but in_progress with invalid_state', () => {
    expect(correctWorkflow(record('in_progress', [p('a', 1)]), CLERK)).toEqual({
      ok: false,
      refusal: 'forbidden',
    });
    for (const state of ['draft', 'sent', 'correcting', 'completed', 'declined'] as const) {
      expect(correctWorkflow(record(state, [p('a', 1)]), MANAGER)).toEqual({
        ok: false,
        refusal: 'invalid_state',
      });
    }
  });
});

describe('compareWithSent (criterion 4, the comparison)', () => {
  it('reports no change for an identical document', () => {
    expect(compareWithSent(SENT, { ...SENT, fields: { ...SENT.fields } })).toEqual({
      bodyChanged: false,
      changedFields: [],
    });
  });

  it('treats a missing field and a null field as the same, and a changed value as a change', () => {
    const head: DocumentSnapshot = {
      body: SENT.body,
      fields: { 'lease.total': '1300', 'tenant.name': null },
    };
    expect(compareWithSent(SENT, head)).toEqual({
      bodyChanged: false,
      changedFields: ['lease.total', 'tenant.name'],
    });
    expect(compareWithSent({ body: 'x', fields: {} }, { body: 'x', fields: { a: null } })).toEqual({
      bodyChanged: false,
      changedFields: [],
    });
  });

  it('is symmetric in the sets of fields it reports (property)', () => {
    const keys = fc.constantFrom('a', 'b', 'c');
    const vals = fc.option(fc.constantFrom('1', '2'), { nil: null });
    const snap = fc.record({
      body: fc.constantFrom('x', 'y'),
      fields: fc.dictionary(keys, vals),
    });
    fc.assert(
      fc.property(snap, snap, (x, y) => {
        expect(compareWithSent(x, y).changedFields).toEqual(compareWithSent(y, x).changedFields);
        expect(compareWithSent(x, y).bodyChanged).toBe(compareWithSent(y, x).bodyChanged);
      }),
    );
  });
});

describe('resume (criteria 4, 5 and 6)', () => {
  const corrected = (participants: WorkflowParticipant[]): WorkflowRecord =>
    record('correcting', participants);

  it('resets every completed participant when the body changed, and returns to in_progress', () => {
    const r = corrected([
      p('tenant', 1, 'signer', true),
      p('landlord', 2, 'signer', true),
      p('agent', 3),
    ]);
    const head = { ...SENT, body: 'Lease for unit 5.' };
    const out = resumeWorkflow(r, MANAGER, compareWithSent(SENT, head), OWNERS);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.reset).toEqual(['tenant', 'landlord']);
    expect(out.record.state).toBe('in_progress');
    expect(out.record.participants.every((x) => !x.completed)).toBe(true);
  });

  it('resets only the completed participant who owns a changed field', () => {
    const r = corrected([p('tenant', 1, 'signer', true), p('landlord', 1, 'signer', true)]);
    const head = { body: SENT.body, fields: { ...SENT.fields, 'lease.total': '1300' } };
    const out = resumeWorkflow(r, MANAGER, compareWithSent(SENT, head), OWNERS);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.reset).toEqual(['landlord']);
    expect(out.record.participants.map((x) => [x.id, x.completed])).toEqual([
      ['tenant', true],
      ['landlord', false],
    ]);
  });

  it('resets nobody when nothing relevant changed, and returns to in_progress', () => {
    const r = corrected([p('tenant', 1, 'signer', true), p('landlord', 2)]);
    const out = resumeWorkflow(r, MANAGER, compareWithSent(SENT, SENT), OWNERS);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.reset).toEqual([]);
    expect(out.record.state).toBe('in_progress');
    expect(out.record.participants).toEqual(r.participants);
  });

  it('treats a changed field with no owner as a body change, so no signature stays over it', () => {
    const r = corrected([p('tenant', 1, 'signer', true)]);
    const head = { body: SENT.body, fields: { ...SENT.fields, 'unowned.key': 'v' } };
    const out = resumeWorkflow(r, MANAGER, compareWithSent(SENT, head), OWNERS);
    expect(out.ok && out.reset).toEqual(['tenant']);
  });

  it('never leaves a completed participant completed over a changed body (property)', () => {
    const completedFlags = fc.array(fc.boolean(), { minLength: 1, maxLength: 6 });
    fc.assert(
      fc.property(completedFlags, fc.boolean(), (flags, bodyChanged) => {
        const participants = flags.map((done, i) => p(`p${i}`, 1, 'signer', done));
        const head = { body: bodyChanged ? 'changed' : SENT.body, fields: SENT.fields };
        const out = resumeWorkflow(
          corrected(participants),
          MANAGER,
          compareWithSent(SENT, head),
          {},
        );
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        if (bodyChanged) expect(out.record.participants.some((x) => x.completed)).toBe(false);
        else expect(out.record.participants.map((x) => x.completed)).toEqual(flags);
      }),
    );
  });

  it('refuses a caller without manage with forbidden, and any state but correcting with invalid_state', () => {
    const c = compareWithSent(SENT, SENT);
    expect(resumeWorkflow(corrected([p('a', 1)]), CLERK, c, OWNERS)).toEqual({
      ok: false,
      refusal: 'forbidden',
    });
    expect(resumeWorkflow(record('in_progress', [p('a', 1)]), MANAGER, c, OWNERS)).toEqual({
      ok: false,
      refusal: 'invalid_state',
    });
  });

  it('correct then resume without a change returns the same participants to in_progress (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 5 }), (flags) => {
        const participants = flags.map((done, i) => p(`q${i}`, 1, 'signer', done));
        const start = record('in_progress', participants);
        const paused = correctWorkflow(start, MANAGER);
        expect(paused.ok).toBe(true);
        if (!paused.ok) return;
        const resumed = resumeWorkflow(paused.record, MANAGER, compareWithSent(SENT, SENT), OWNERS);
        expect(resumed.ok && resumed.record.state).toBe('in_progress');
        expect(resumed.ok && resumed.record.participants.map((x) => x.completed)).toEqual(flags);
      }),
    );
  });
});
