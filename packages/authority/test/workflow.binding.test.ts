// Binding a host-minted token to a workflow participant (FRW-038 criteria 2 and 6, the rule part; the
// token service builds the connection and is not changed here). Property tests over the states.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { bindParticipant, tokenMayFill } from '../src/workflow/binding.ts';
import {
  type WorkflowParticipant,
  type WorkflowRecord,
  type WorkflowStateName,
  WORKFLOW_STATE_NAMES,
} from '../src/workflow/lifecycle.ts';

const person = (id: string, sub: string | undefined, order = 1): WorkflowParticipant => ({
  id,
  roles: ['role_tenant'],
  kind: 'signer',
  order,
  completed: false,
  ...(sub !== undefined ? { sub } : {}),
});

const workflow = (state: WorkflowStateName): WorkflowRecord => ({
  state,
  participants: [person('p1', 'ext:7f3a'), person('p2', 'u_481', 2)],
  sentSeq: 640,
  sentHash: 'c'.repeat(64),
  end: null,
});

describe('binding a token to a participant (FRW-038 criterion 2)', () => {
  it('binds a token whose wfp and sub name the participant of this workflow', () => {
    const r = bindParticipant({ sub: 'ext:7f3a', wfp: 'p1' }, workflow('in_progress'));
    expect(r).toMatchObject({ ok: true, participant: { id: 'p1' } });
  });

  it('binds to no one a wfp that names a participant of another document workflow', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^x[a-z0-9]{1,12}$/), (other) => {
        const r = bindParticipant({ sub: 'ext:7f3a', wfp: other }, workflow('in_progress'));
        expect(r).toEqual({ ok: false, reason: 'not_in_workflow' });
      }),
    );
  });

  it('binds to no one a token whose sub differs from the recorded sub, and a token with no wfp', () => {
    expect(bindParticipant({ sub: 'ext:other', wfp: 'p1' }, workflow('in_progress'))).toEqual({
      ok: false,
      reason: 'sub_mismatch',
    });
    expect(bindParticipant({ sub: 'ext:7f3a' }, workflow('in_progress'))).toEqual({
      ok: false,
      reason: 'no_claim',
    });
  });

  it('refuses to bind a participant whose sub the host has not recorded', () => {
    const wf: WorkflowRecord = {
      ...workflow('in_progress'),
      participants: [person('p1', undefined)],
    };
    expect(bindParticipant({ sub: 'ext:7f3a', wfp: 'p1' }, wf)).toEqual({
      ok: false,
      reason: 'sub_not_recorded',
    });
  });
});

describe('fill from a bound token (FRW-038 criterion 6, the rule part)', () => {
  it('yields fill to the bound participant only while the workflow runs and they are active', () => {
    fc.assert(
      fc.property(fc.constantFrom(...WORKFLOW_STATE_NAMES), (state) => {
        const claims = { sub: 'ext:7f3a', wfp: 'p1' };
        const may = tokenMayFill(claims, workflow(state));
        expect(may).toBe(state === 'sent' || state === 'in_progress');
      }),
    );
  });

  it('yields no fill to a participant of a declined, voided or expired workflow', () => {
    for (const state of ['declined', 'voided', 'expired'] as const) {
      expect(tokenMayFill({ sub: 'ext:7f3a', wfp: 'p1' }, workflow(state))).toBe(false);
    }
  });

  it('yields no fill to the second participant until the first has completed', () => {
    const claims = { sub: 'u_481', wfp: 'p2' };
    expect(tokenMayFill(claims, workflow('in_progress'))).toBe(false);
    const done: WorkflowRecord = {
      ...workflow('in_progress'),
      participants: [{ ...person('p1', 'ext:7f3a'), completed: true }, person('p2', 'u_481', 2)],
    };
    expect(tokenMayFill(claims, done)).toBe(true);
  });
});
