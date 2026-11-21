/**
 * FRW-024 in the editing core, in Node.js (lane w4): the rules of a document are listed, added,
 * changed and deleted through the core (`ruleDefs`, `editRule`, src/rule-edit.ts), each as one
 * commit of the definitions. A rule that names a key the document lacks, or that makes a cycle, is
 * refused with the keys concerned; the 501st rule is refused; a user without `structure` changes
 * nothing. The builder's form and its browser run are in packages/ui.
 */
import type { Access } from '@docedit/protocol';
import { beforeAll, describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { FIELD_IDS, fieldsDocument, participantAccess } from './frw-fields-fixture.ts';
import { RULE_FIELD_IDS, ruleDocument } from './frw-023-fixture.ts';
import { loadParts } from '../src/parts.ts';

// The rules language and the authoring checks load on first use (FND-008; engine parts.ts).
beforeAll(() => loadParts(['authoring', 'rules']));

const schedule = (run: () => void): void => queueMicrotask(run);
const core = (doc = fieldsDocument()): DocumentCore => new DocumentCore({ doc, schedule });

const HIDE_NAME = {
  id: 'r_hide',
  when: { '==': [{ field: 'tenant.amount' }, '5'] },
  then: [{ hide: ['tenant.name'] }],
  else: [{ show: ['tenant.name'] }],
};

/** Someone who may change the body and nothing of the definitions. */
const bodyEditor = {
  rev: 2,
  asOfSeq: 0,
  docRole: 'commenter',
  caps: ['view', 'comment'],
  scopes: { doc: ['view'], body: ['view', 'edit'], defs: ['view'] },
  leases: {},
  fill: null,
  restrictions: [],
} as unknown as Access;

describe('adding and changing a rule (FRW-024 criterion 1, the saved rule_def)', () => {
  it('adds a rule as a rule_def, and the rule governs the field at once', () => {
    const c = core();
    expect(c.ruleDefs()).toEqual([]);
    expect(c.editRule({ op: 'save', rule: HIDE_NAME })).toEqual({ ok: true });
    expect(c.ruleDefs()).toEqual([{ id: 'r_hide', rule: HIDE_NAME }]);
    // It is a node of the definitions in the document, as every rule is.
    expect(JSON.stringify(c.getContent().doc)).toContain('"type":"rule_def"');
    c.enterFieldValue(FIELD_IDS.amount, '5');
    expect(c.fieldRuleState(FIELD_IDS.name)).toMatchObject({ visible: false });
    c.destroy();
  });

  it('replaces a rule, changing only the attributes that differ, and one undo takes it back', () => {
    const c = core();
    c.editRule({ op: 'save', rule: HIDE_NAME });
    const changed = { ...HIDE_NAME, then: [{ disable: ['tenant.name'] }] };
    expect(c.editRule({ op: 'save', rule: changed, replace: 'r_hide' })).toEqual({ ok: true });
    expect(c.ruleDefs()[0]?.rule['then']).toEqual([{ disable: ['tenant.name'] }]);
    expect(c.editRule({ op: 'save', rule: changed, replace: 'r_hide' })).toEqual({
      ok: false,
      reason: 'no-change',
    });
    expect(c.run('undo')).toBe(true);
    expect(c.ruleDefs()[0]?.rule['then']).toEqual([{ hide: ['tenant.name'] }]);
    c.destroy();
  });

  it('deletes a rule, and refuses an identifier that is used by another rule or unknown', () => {
    const c = core();
    c.editRule({ op: 'save', rule: HIDE_NAME });
    expect(c.editRule({ op: 'save', rule: HIDE_NAME })).toEqual({
      ok: false,
      reason: 'duplicate',
    });
    expect(c.editRule({ op: 'delete', id: 'r_none' })).toEqual({
      ok: false,
      reason: 'not-defined',
    });
    expect(c.editRule({ op: 'delete', id: 'r_hide' })).toEqual({ ok: true });
    expect(c.ruleDefs()).toEqual([]);
    c.destroy();
  });

  it('keeps the rules of a document as they are listed (a document that already has rules)', () => {
    const c = core(ruleDocument());
    expect(c.ruleDefs().map((r) => r.id)).toEqual(['r_spouse', 'r_amount', 'r_lock', 'r_total']);
    expect(c.ruleDefs()[0]?.rule['when']).toEqual({
      '==': [{ field: 'tenant.name' }, 'Ada'],
    });
    expect(c.fieldRuleState(RULE_FIELD_IDS.spouse)).not.toBeNull();
    c.destroy();
  });
});

describe('a rule the document cannot hold (FRW-024 criterion 3, I14)', () => {
  it('refuses a rule that names a key the document lacks, with the key', () => {
    const c = core();
    const before = JSON.stringify(c.getContent().doc);
    const out = c.editRule({
      op: 'save',
      rule: { id: 'r_bad', when: { '==': [{ field: 'tenant.nobody' }, '1'] }, then: [] },
    });
    expect(out).toMatchObject({ ok: false, reason: 'invalid_rules' });
    if (!out.ok && out.reason === 'invalid_rules')
      expect(out.problems.some((p) => p.keys?.includes('tenant.nobody'))).toBe(true);
    expect(JSON.stringify(c.getContent().doc)).toBe(before);
    c.destroy();
  });

  it('refuses a rule that makes a cycle among computed fields, with the keys on it', () => {
    const doc = ruleDocument();
    const c = core(doc);
    // r_total sets the total from the amount; this rule sets the amount from the total.
    const out = c.editRule({
      op: 'save',
      rule: {
        id: 'r_cycle',
        when: true,
        then: [{ set: { field: 'tenant.amount', value: { field: 'tenant.total' } } }],
      },
    });
    expect(out.ok).toBe(false);
    c.destroy();
  });
});

describe('the limit of 500 rules (FRW-024 criterion 4, I15)', () => {
  it('refuses the 501st rule with a message', () => {
    const c = core();
    for (let i = 0; i < 500; i++) {
      const out = c.editRule({
        op: 'save',
        rule: {
          id: `r${i}`,
          when: { '==': [{ field: 'tenant.amount' }, String(i)] },
          then: [{ require: ['tenant.name'] }],
        },
      });
      if (!out.ok) throw new Error(`rule ${i} was refused: ${JSON.stringify(out)}`);
    }
    expect(c.ruleDefs()).toHaveLength(500);
    const out = c.editRule({
      op: 'save',
      rule: { id: 'r500', when: { '==': [{ field: 'tenant.amount' }, '500'] }, then: [] },
    });
    expect(out).toMatchObject({ ok: false, reason: 'rule_limit', limit: 500 });
    if (!out.ok && out.reason === 'rule_limit') expect(out.message).toMatch(/at most 500/);
    c.destroy();
  });
});

describe('without structure (FRW-024 criterion 5)', () => {
  it('changes nothing, and the list stays readable', () => {
    for (const access of [participantAccess(['role_tenant']), bodyEditor]) {
      const c = core(ruleDocument());
      c.setAccess(access);
      const before = JSON.stringify(c.getContent().doc);
      expect(c.editRule({ op: 'save', rule: HIDE_NAME }, true)).toEqual({
        ok: false,
        reason: 'read-only',
      });
      expect(c.editRule({ op: 'save', rule: HIDE_NAME })).toEqual({
        ok: false,
        reason: 'read-only',
      });
      expect(c.editRule({ op: 'delete', id: 'r_spouse' })).toEqual({
        ok: false,
        reason: 'read-only',
      });
      expect(JSON.stringify(c.getContent().doc)).toBe(before);
      expect(c.ruleDefs()).toHaveLength(4);
      c.destroy();
    }
  });
});
