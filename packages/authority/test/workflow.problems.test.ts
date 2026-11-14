// The registry codes of refused workflow transitions (FRW-027 criteria 2 and 6, FRW-033 criteria 3
// and 6; docs/adr/0249-lane-FRW-027-039.md decision 10). The refusals come from the real
// `sendWorkflow`, `declineWorkflow`, `voidWorkflow` and `completeParticipant`; the codes and their
// HTTP statuses are checked against the generated registry, spec/dep/dep-1.registry.json.
import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type Caller,
  WORKFLOW_STATE_NAMES,
  type WorkflowParticipant,
  type WorkflowRecord,
  declineWorkflow,
  voidWorkflow,
} from '../src/workflow/lifecycle.ts';
import { completeParticipant } from '../src/workflow/order.ts';
import {
  WORKFLOW_PROBLEM_STATUS,
  sendProblem,
  transitionProblem,
} from '../src/workflow/problems.ts';
import { sendWorkflow } from '../src/workflow/send.ts';

const registry = JSON.parse(
  readFileSync(new URL('../../../spec/dep/dep-1.registry.json', import.meta.url), 'utf8'),
) as { errors: Array<{ code: string; httpStatus?: number; surfaces: string[] }> };

const HEAD = { seq: 7, hash: 'b'.repeat(64) };
const OWNER: Caller = { manage: true };
const OTHER: Caller = { manage: false };

const participant = (id: string, roles: string[], order = 1): WorkflowParticipant => ({
  id,
  roles,
  kind: 'filler',
  order,
  completed: false,
});

function record(
  state: WorkflowRecord['state'],
  participants: readonly WorkflowParticipant[] = [],
): WorkflowRecord {
  return { state, participants, sentSeq: null, sentHash: null, end: null };
}

const roleNode = (id: string) => ({ type: 'role_def', attrs: { id, name: id, color: '#1F77B4' } });
const suggestion = (id: string) => ({
  type: 'paragraph',
  content: [{ type: 'text', text: 'Proposed', marks: [{ type: 'ins', attrs: { id } }] }],
});
const unassigned = (key: string) => ({
  type: 'paragraph',
  content: [
    {
      type: 'form_field',
      attrs: {
        id: `fField${key.padEnd(10, '0')}`,
        key,
        kind: 'text',
        label: key,
        assignee: null,
        required: true,
        readOnly: false,
        value: null,
      },
    },
  ],
});
const docOf = (content: unknown[]) => ({ type: 'doc', content });

describe('every code is a REST code of the registry, with its status', () => {
  it('matches spec/dep/dep-1.registry.json', () => {
    for (const [code, status] of Object.entries(WORKFLOW_PROBLEM_STATUS)) {
      const entry = registry.errors.find((e) => e.code === code);
      expect(entry, code).toBeDefined();
      expect(entry!.surfaces).toContain('rest');
      expect(entry!.httpStatus).toBe(status);
    }
  });
});

describe('a refused send (FRW-027 criteria 2 and 6)', () => {
  it('without manage: forbidden, 403', () => {
    const r = sendWorkflow(record('draft'), OTHER, docOf([]), HEAD);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(sendProblem(r)).toMatchObject({ code: 'forbidden', status: 403, failures: [] });
  });

  it('from any state but draft: conflict, 409', () => {
    for (const state of WORKFLOW_STATE_NAMES.filter((s) => s !== 'draft')) {
      const r = sendWorkflow(record(state), OWNER, docOf([]), HEAD);
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(sendProblem(r)).toMatchObject({ code: 'conflict', status: 409, failures: [] });
    }
  });

  it('with unresolved suggestions only: pending_suggestions, 409, with every suggestion identifier', () => {
    const r = sendWorkflow(
      record('draft'),
      OWNER,
      docOf([suggestion('s-1'), suggestion('s-2')]),
      HEAD,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(sendProblem(r)).toEqual({
      code: 'pending_suggestions',
      status: 409,
      detail: 'the send checklist failed: pending_suggestions',
      failures: [
        {
          code: 'pending_suggestions',
          suggestionIds: ['s-1', 's-2'],
          registryCode: 'pending_suggestions',
        },
      ],
    });
  });

  it('with several failing checks: validation_failed, 400, each failure with its own registry code', () => {
    const r = sendWorkflow(
      record('draft', [participant('p1', ['tenant'])]),
      OWNER,
      docOf([roleNode('tenant'), roleNode('guarantor'), unassigned('deposit'), suggestion('s-9')]),
      HEAD,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const p = sendProblem(r);
    expect(p.code).toBe('validation_failed');
    expect(p.status).toBe(400);
    expect(p.failures).toEqual([
      { code: 'required_field_unassigned', keys: ['deposit'], registryCode: 'validation_failed' },
      { code: 'role_without_participant', roles: ['guarantor'], registryCode: 'validation_failed' },
      { code: 'pending_suggestions', suggestionIds: ['s-9'], registryCode: 'pending_suggestions' },
    ]);
  });

  it('lists exactly the checklist failures, and the code is pending_suggestions only when nothing else fails (property)', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom('a', 'b', 'c'), { maxLength: 3 }),
        fc.uniqueArray(fc.constantFrom('r1', 'r2'), { maxLength: 2 }),
        fc.uniqueArray(fc.constantFrom('s1', 's2', 's3'), { maxLength: 3 }),
        (fields, roles, suggestions) => {
          const input = docOf([
            ...roles.map(roleNode),
            ...fields.map(unassigned),
            ...suggestions.map(suggestion),
          ]);
          const r = sendWorkflow(record('draft'), OWNER, input, HEAD);
          if (r.ok) {
            expect(fields.length + roles.length + suggestions.length).toBe(0);
            return;
          }
          const p = sendProblem(r);
          expect(p.failures.map(({ registryCode: _, ...rest }) => rest)).toEqual(r.problems);
          const onlySuggestions = suggestions.length > 0 && fields.length + roles.length === 0;
          expect(p.code).toBe(onlySuggestions ? 'pending_suggestions' : 'validation_failed');
          expect(p.status).toBe(WORKFLOW_PROBLEM_STATUS[p.code]);
        },
      ),
    );
  });
});

describe('a refused decline, void or completion (FRW-033 criteria 3 and 6; FRW-031)', () => {
  const running = record('in_progress', [participant('p1', ['tenant']), participant('p2', [], 2)]);

  it('a blank reason: validation_failed, 400', () => {
    for (const t of [declineWorkflow(running, 'p1', '  '), voidWorkflow(running, OWNER, '')]) {
      expect(t.ok).toBe(false);
      if (t.ok) continue;
      expect(transitionProblem(t.refusal)).toMatchObject({
        code: 'validation_failed',
        status: 400,
      });
    }
  });

  it('a void without manage: forbidden, 403, in every state', () => {
    for (const state of WORKFLOW_STATE_NAMES) {
      const t = voidWorkflow(record(state), OTHER, 'reason');
      expect(t.ok).toBe(false);
      if (t.ok) continue;
      expect(transitionProblem(t.refusal)).toMatchObject({ code: 'forbidden', status: 403 });
    }
  });

  it('a transition the state does not allow: conflict, 409; a participant not active: forbidden', () => {
    const v = voidWorkflow(record('completed'), OWNER, 'reason');
    expect(!v.ok && transitionProblem(v.refusal).code).toBe('conflict');
    const c = completeParticipant(running, 'p2');
    expect(!c.ok && transitionProblem(c.refusal).code).toBe('forbidden');
    const d = completeParticipant(record('sent', running.participants), 'p1');
    expect(!d.ok && transitionProblem(d.refusal).code).toBe('conflict');
  });
});
