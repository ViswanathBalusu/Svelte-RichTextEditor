// Declining and voiding a workflow, and what a stopped workflow admits (FRW-033 criteria 3, 4 and 6,
// and the state parts of 1 and 2). Pure functions only.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type WorkflowParticipant,
  type WorkflowRecord,
  type WorkflowStateName,
  WORKFLOW_STATE_NAMES,
  declineWorkflow,
  isStopped,
  normaliseReason,
  openWorkflow,
  voidWorkflow,
} from '../src/workflow/lifecycle.ts';
import { sendWorkflow } from '../src/workflow/send.ts';

const OWNER = { manage: true };
const MEMBER = { manage: false };

const part = (id: string, kind: WorkflowParticipant['kind'] = 'filler'): WorkflowParticipant => ({
  id,
  roles: [],
  kind,
  order: 1,
  completed: false,
});

function at(state: WorkflowStateName): WorkflowRecord {
  return {
    state,
    participants: [part('tenant'), part('observer', 'cc')],
    sentSeq: state === 'draft' ? null : 3,
    sentHash: state === 'draft' ? null : 'c'.repeat(64),
    end: null,
  };
}

const whitespace = fc
  .array(fc.constantFrom(' ', '\t', '\n'), { maxLength: 8 })
  .map((chars) => chars.join(''));
const reasonArb = fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.trim().length > 0);

describe('a decline or void without a reason is rejected and changes nothing (FRW-033 criterion 3)', () => {
  it('refuses a blank reason for decline and void, and the record is not changed (property)', () => {
    fc.assert(
      fc.property(whitespace, (reason) => {
        expect(normaliseReason(reason)).toBeNull();
        const inProgress = at('in_progress');
        const before = structuredClone(inProgress);
        expect(declineWorkflow(inProgress, 'tenant', reason)).toEqual({
          ok: false,
          refusal: 'reason_required',
        });
        expect(voidWorkflow(inProgress, OWNER, reason)).toEqual({
          ok: false,
          refusal: 'reason_required',
        });
        expect(inProgress).toEqual(before);
      }),
    );
  });

  it('records a decline with its trimmed reason and the participant', () => {
    fc.assert(
      fc.property(reasonArb, (reason) => {
        const result = declineWorkflow(at('in_progress'), 'tenant', `  ${reason}  `);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.record.state).toBe('declined');
        expect(result.record.end).toEqual({
          state: 'declined',
          by: 'tenant',
          reason: reason.trim(),
        });
      }),
    );
  });
});

describe('void is for a caller with manage, from sent or in_progress (FRW-033 criteria 2 and 6)', () => {
  it('refuses a void by a caller without manage with forbidden, in every state (criterion 6)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...WORKFLOW_STATE_NAMES), reasonArb, (state, reason) => {
        expect(voidWorkflow(at(state), MEMBER, reason)).toEqual({
          ok: false,
          refusal: 'forbidden',
        });
      }),
    );
  });

  it('voids a sent or in_progress workflow with the reason and no participant (criterion 2, state part)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<WorkflowStateName>('sent', 'in_progress'),
        reasonArb,
        (state, reason) => {
          const result = voidWorkflow(at(state), OWNER, reason);
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          expect(result.record.state).toBe('voided');
          expect(result.record.end).toEqual({ state: 'voided', by: null, reason: reason.trim() });
        },
      ),
    );
  });

  it('refuses a void from any other state with invalid_state', () => {
    const others = WORKFLOW_STATE_NAMES.filter((s) => s !== 'sent' && s !== 'in_progress');
    fc.assert(
      fc.property(fc.constantFrom(...others), reasonArb, (state, reason) => {
        expect(voidWorkflow(at(state), OWNER, reason)).toEqual({
          ok: false,
          refusal: 'invalid_state',
        });
      }),
    );
  });
});

describe('a declined or voided workflow admits no further transition (FRW-033 criterion 4, the transitions)', () => {
  it('refuses open, decline, void and send from declined and voided, and reports them as stopped', () => {
    for (const state of ['declined', 'voided'] as const) {
      const record = at(state);
      expect(isStopped(state)).toBe(true);
      expect(openWorkflow(record)).toEqual({ ok: false, refusal: 'invalid_state' });
      expect(declineWorkflow(record, 'tenant', 'again')).toEqual({
        ok: false,
        refusal: 'invalid_state',
      });
      expect(voidWorkflow(record, OWNER, 'again')).toEqual({ ok: false, refusal: 'invalid_state' });
      expect(
        sendWorkflow(record, OWNER, { type: 'doc', content: [] }, { seq: 1, hash: 'd'.repeat(64) }),
      ).toEqual({
        ok: false,
        refusal: 'invalid_state',
        problems: [],
      });
    }
  });

  it('does not treat the other states as stopped', () => {
    const stopped = WORKFLOW_STATE_NAMES.filter((s) => isStopped(s));
    expect(stopped).toEqual(['voided', 'declined']);
  });
});

describe('a decline needs an in_progress workflow and a participant who must act', () => {
  it('refuses a decline from sent, and a decline by a cc or an unknown participant', () => {
    expect(declineWorkflow(at('sent'), 'tenant', 'no')).toEqual({
      ok: false,
      refusal: 'invalid_state',
    });
    expect(declineWorkflow(at('in_progress'), 'observer', 'no')).toEqual({
      ok: false,
      refusal: 'forbidden',
    });
    expect(declineWorkflow(at('in_progress'), 'nobody', 'no')).toEqual({
      ok: false,
      refusal: 'forbidden',
    });
  });
});
