// Sending a document for completion: the checklist and the transition from draft to sent (FRW-027
// criteria 1, 2 and 6, and the state part of criterion 3). Pure functions only.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type Caller,
  WORKFLOW_STATE_NAMES,
  type WorkflowParticipant,
  type WorkflowRecord,
  type WorkflowStateName,
} from '../src/workflow/lifecycle.ts';
import { activeParticipantIds } from '../src/workflow/order.ts';
import { sendChecklist, sendWorkflow } from '../src/workflow/send.ts';

const OWNER: Caller = { manage: true };
const HEAD = { seq: 42, hash: 'a'.repeat(64) };

function draft(participants: WorkflowParticipant[]): WorkflowRecord {
  return { state: 'draft', participants, sentSeq: null, sentHash: null, end: null };
}

const participant = (
  id: string,
  roles: string[],
  order = 1,
  kind: WorkflowParticipant['kind'] = 'filler',
): WorkflowParticipant => ({ id, roles, kind, order, completed: false });

function fieldNode(key: string, opts: { required: boolean; assignee: string | null }) {
  return {
    type: 'form_field',
    attrs: {
      id: `fField${key.padEnd(10, '0')}`,
      key,
      kind: 'text',
      label: key,
      assignee: opts.assignee,
      required: opts.required,
      readOnly: false,
      value: null,
    },
  };
}

const roleNode = (id: string) => ({ type: 'role_def', attrs: { id, name: id, color: '#1F77B4' } });

function docOf(content: unknown[]) {
  return { type: 'doc', content };
}

describe('the checklist passes a complete draft (FRW-027 criterion 1)', () => {
  it('reports nothing when every check passes, and the draft is sent with its head', () => {
    const input = docOf([
      roleNode('tenant'),
      roleNode('landlord'),
      { type: 'paragraph', content: [fieldNode('rent', { required: true, assignee: 'tenant' })] },
      { type: 'paragraph', content: [fieldNode('note', { required: false, assignee: null })] },
    ]);
    const participants = [participant('p1', ['tenant']), participant('p2', ['landlord'])];
    expect(sendChecklist(input, participants)).toEqual([]);

    const result = sendWorkflow(draft(participants), OWNER, input, HEAD);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.state).toBe('sent');
    expect(result.record.sentSeq).toBe(42);
    expect(result.record.sentHash).toBe(HEAD.hash);
    expect(activeParticipantIds(result.record.participants)).toEqual(['p1', 'p2']);
  });
});

describe('every failure is listed, and a refused send leaves the draft unchanged (FRW-027 criterion 2)', () => {
  it('lists the unassigned field, the role without a participant and the suggestion together', () => {
    const input = docOf([
      roleNode('tenant'),
      roleNode('guarantor'),
      { type: 'paragraph', content: [fieldNode('deposit', { required: true, assignee: null })] },
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'Proposed wording',
            marks: [{ type: 'ins', attrs: { id: 's-17' } }],
          },
        ],
      },
    ]);
    const record = draft([participant('p1', ['tenant'])]);
    const before = structuredClone(record);

    const problems = sendChecklist(input, record.participants);
    expect(problems).toEqual([
      { code: 'required_field_unassigned', keys: ['deposit'] },
      { code: 'role_without_participant', roles: ['guarantor'] },
      { code: 'pending_suggestions', suggestionIds: ['s-17'] },
    ]);

    const result = sendWorkflow(record, OWNER, input, HEAD);
    expect(result).toEqual({ ok: false, refusal: 'checklist_failed', problems });
    expect(record).toEqual(before);
    expect(record.state).toBe('draft');
  });

  it('names the registry code pending_suggestions for an unresolved tracked change', () => {
    const input = docOf([
      { type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'del' }] }] },
    ]);
    const problems = sendChecklist(input, []);
    expect(problems).toEqual([{ code: 'pending_suggestions', suggestionIds: [null] }]);
  });

  it('refuses a rule set that does not compile, with the rule problems', () => {
    const input = docOf([
      roleNode('tenant'),
      { type: 'rule_def', attrs: { id: 'r_bad', when: { notAnOperator: [] }, then: [] } },
    ]);
    const problems = sendChecklist(input, [participant('p1', ['tenant'])]);
    expect(problems.map((p) => p.code)).toEqual(['rules_invalid']);
    const rules = problems[0];
    expect(rules?.code === 'rules_invalid' && rules.problems.length > 0).toBe(true);
  });

  it('lists every field key and every role identifier (property)', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.record({
            key: fc.constantFrom('a', 'b', 'c', 'd', 'e'),
            required: fc.boolean(),
            assignee: fc.option(fc.constantFrom('tenant', 'landlord', 'agent'), { nil: null }),
          }),
          { selector: (f) => f.key, maxLength: 5 },
        ),
        fc.subarray(['tenant', 'landlord', 'agent', 'guarantor'], { minLength: 1 }),
        fc.subarray(['tenant', 'landlord', 'agent', 'guarantor']),
        (fields, roles, held) => {
          const input = docOf([
            ...roles.map(roleNode),
            ...fields.map((f) => fieldNode(f.key, { required: f.required, assignee: f.assignee })),
          ]);
          const problems = sendChecklist(input, [participant('p', held)]);
          const unassigned = fields
            .filter((f) => f.required && f.assignee === null)
            .map((f) => f.key);
          const missing = roles.filter((r) => !held.includes(r));
          const got = problems.find((p) => p.code === 'required_field_unassigned');
          const gotRoles = problems.find((p) => p.code === 'role_without_participant');
          expect(got?.code === 'required_field_unassigned' ? [...got.keys].sort() : []).toEqual(
            [...unassigned].sort(),
          );
          expect(
            gotRoles?.code === 'role_without_participant' ? [...gotRoles.roles].sort() : [],
          ).toEqual([...missing].sort());
          expect(problems.some((p) => p.code === 'pending_suggestions')).toBe(false);
        },
      ),
    );
  });
});

describe('the transition from draft to sent (FRW-027 criterion 6 and the refusals)', () => {
  it('refuses a caller without manage with forbidden, whatever the document (criterion 6)', () => {
    fc.assert(
      fc.property(fc.boolean(), (withProblems) => {
        const input = withProblems ? docOf([roleNode('unheld')]) : docOf([]);
        const result = sendWorkflow(draft([]), { manage: false }, input, HEAD);
        expect(result).toEqual({ ok: false, refusal: 'forbidden', problems: [] });
      }),
    );
  });

  it('refuses a send when the state is not draft, and changes nothing (criterion 5, the refusal part)', () => {
    const states = WORKFLOW_STATE_NAMES.filter((s) => s !== 'draft');
    fc.assert(
      fc.property(fc.constantFrom(...states), (state: WorkflowStateName) => {
        const record: WorkflowRecord = { ...draft([]), state };
        const before = structuredClone(record);
        expect(sendWorkflow(record, OWNER, docOf([]), HEAD)).toEqual({
          ok: false,
          refusal: 'invalid_state',
          problems: [],
        });
        expect(record).toEqual(before);
      }),
    );
  });
});
