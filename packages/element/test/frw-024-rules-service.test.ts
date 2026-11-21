/**
 * FRW-024: the shell's rules port over the editing core (`rulesService`, src/rules.ts), in Node.js.
 * The core is the headless one, which the editor core extends; the port reads and changes the
 * rules through its public members only. The list is sentence parts; a save is a commit of the
 * definitions; a refusal carries the keys; a user without `structure` is read-only.
 */
import { DocumentCore, loadParts } from '@docedit/engine/headless';
import type { EditorCore } from '@docedit/engine';
import type { RulePartsView } from '@docedit/ui';
import { beforeAll, describe, expect, it } from 'vitest';
import { rulesService } from '../src/rules.ts';
import { ruleDocument } from '../../engine/test/frw-023-fixture.ts';
import { participantAccess } from '../../engine/test/frw-fields-fixture.ts';

// The rules language loads on first use (FND-008; engine parts.ts).
beforeAll(() => loadParts(['rules']));

const schedule = (run: () => void): void => queueMicrotask(run);
const open = (): { core: DocumentCore; service: ReturnType<typeof rulesService> } => {
  const core = new DocumentCore({ doc: ruleDocument(), schedule });
  return { core, service: rulesService(core as unknown as EditorCore) };
};

const PARTS: RulePartsView = {
  left: { field: 'tenant.amount' },
  operator: '>=',
  right: { literal: '100' },
  then: [{ effect: 'require', keys: ['tenant.email'] }],
  otherwise: null,
};

describe('the rules port (FRW-024)', () => {
  it('lists the rules as sentence parts, and one that has no sentence form as JSON', () => {
    const { service } = open();
    const items = service.rules.get();
    expect(items.map((r) => r.id)).toEqual(['r_spouse', 'r_amount', 'r_lock', 'r_total']);
    expect(items[0]?.parts).toMatchObject({
      left: { field: 'tenant.name' },
      operator: '==',
      right: { literal: 'Ada' },
      otherwise: [{ effect: 'hide', keys: ['tenant.spouse'] }],
    });
    // r_total sets a formula: not of the sentence form.
    expect(items[3]?.parts).toBeNull();
    expect(JSON.parse(items[3]!.json)).toMatchObject({ id: 'r_total' });
    expect(service.fields.get().map((f) => f.key)).toContain('tenant.amount');
  });

  it('saves a new rule as a commit of the definitions, and the list follows', () => {
    const { service } = open();
    expect(service.nextId()).toBe('rule_1');
    expect(service.save({ id: 'rule_1', parts: PARTS })).toEqual({ ok: true });
    const items = service.rules.get();
    expect(items.at(-1)).toMatchObject({ id: 'rule_1', parts: PARTS });
    expect(service.nextId()).toBe('rule_2');
  });

  it('replaces a rule and keeps the members the builder does not edit', () => {
    const { core, service } = open();
    const spouse = service.rules.get()[0]!.parts!;
    const result = service.save({
      id: 'r_spouse',
      replace: 'r_spouse',
      parts: { ...spouse, right: { literal: 'Bob' } },
    });
    expect(result).toEqual({ ok: true });
    expect(core.ruleDefs()[0]?.rule['when']).toEqual({
      '==': [{ field: 'tenant.name' }, 'Bob'],
    });
    expect(core.ruleDefs()[0]?.rule['then']).toEqual([
      { show: ['tenant.spouse'] },
      { require: ['tenant.spouse'] },
    ]);
  });

  it('refuses a key the document lacks, with the key, and changes nothing', () => {
    const { core, service } = open();
    const before = JSON.stringify(core.getContent().doc);
    const result = service.save({
      id: 'rule_1',
      parts: { ...PARTS, then: [{ effect: 'show', keys: ['tenant.nobody'] }] },
    });
    expect(result).toMatchObject({ ok: false, reason: 'invalid_rules' });
    if (!result.ok && result.reason === 'invalid_rules')
      expect(result.problems.some((p) => p.keys.includes('tenant.nobody'))).toBe(true);
    expect(JSON.stringify(core.getContent().doc)).toBe(before);
  });

  it('deletes a rule', () => {
    const { service } = open();
    expect(service.remove('r_lock')).toEqual({ ok: true });
    expect(service.rules.get().map((r) => r.id)).toEqual(['r_spouse', 'r_amount', 'r_total']);
    expect(service.remove('r_lock')).toMatchObject({ ok: false, reason: 'not-defined' });
  });

  it('is read-only without structure, and the list stays readable', () => {
    const { core, service } = open();
    expect(service.canEdit.get()).toBe(true);
    core.setAccess(participantAccess(['role_tenant']));
    expect(service.canEdit.get()).toBe(false);
    expect(service.save({ id: 'rule_1', parts: PARTS })).toMatchObject({
      ok: false,
      reason: 'read-only',
    });
    expect(service.remove('r_spouse')).toMatchObject({ ok: false, reason: 'read-only' });
    expect(service.rules.get()).toHaveLength(4);
  });
});
