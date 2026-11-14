/**
 * The field properties panel's gate (FRW-073 criteria 2, 3 and 4): invalid entries are reported and
 * not committed; a commit is a patch of the changed attributes only; the panel is read-only without
 * `edit` or during a sent or running workflow. The panel's rendering (criteria 1 and 5) is not here.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  FIELD_KINDS,
  FIELD_PROPERTIES,
  canCommitField,
  fieldPanelReadOnly,
  fieldPatch,
  validateFieldDraft,
  type FieldDraft,
  type FieldProblem,
} from '../src/shell/field-properties.ts';

const base: FieldDraft = {
  key: 'tenant.income',
  kind: 'number',
  label: 'Monthly income',
  assignee: 'role_tenant',
  required: true,
  readOnly: false,
  default: null,
  placeholder: '0.00',
  options: [],
  format: { decimals: 2, prefix: 'EUR' },
  validation: { min: '0', max: '1000000' },
  width: 1920,
};

const ctx = { otherKeys: ['landlord.name'], roles: ['role_tenant', 'role_landlord'] };

function codes(problems: readonly FieldProblem[]): string[] {
  return problems.map((p) => `${p.property}:${p.code}`);
}

describe('the entries the panel checks (FRW-073, criterion 2)', () => {
  it('accepts a valid draft and commits it', () => {
    const problems = validateFieldDraft(base, ctx);
    expect(problems).toEqual([]);
    expect(canCommitField(problems)).toBe(true);
  });

  it('refuses a key that another field already has', () => {
    const problems = validateFieldDraft({ ...base, key: 'landlord.name' }, ctx);
    expect(codes(problems)).toEqual(['key:duplicateKey']);
    expect(canCommitField(problems)).toBe(false);
  });

  it('refuses an assignee that is not one of the document roles', () => {
    expect(codes(validateFieldDraft({ ...base, assignee: 'role_nobody' }, ctx))).toEqual([
      'assignee:assigneeNotRole',
    ]);
  });

  it('accepts no assignee, the field only authors set', () => {
    expect(validateFieldDraft({ ...base, assignee: null }, ctx)).toEqual([]);
  });

  it('refuses duplicate option identifiers, empty identifiers and a choice without options', () => {
    const choice = { ...base, kind: 'choice', format: null, validation: null };
    expect(codes(validateFieldDraft({ ...choice, options: [] }, ctx))).toEqual([
      'options:optionsNeeded',
    ]);
    const dup = validateFieldDraft(
      {
        ...choice,
        options: [
          { id: 'a', label: 'A' },
          { id: 'a', label: 'again' },
        ],
      },
      ctx,
    );
    expect(codes(dup)).toEqual(['options:duplicateOption']);
    expect(
      codes(validateFieldDraft({ ...choice, options: [{ id: ' ', label: 'x' }] }, ctx)),
    ).toEqual(['options:emptyOptionId']);
  });

  it('refuses a validation limit that is not a decimal, or a minimum above its maximum', () => {
    expect(codes(validateFieldDraft({ ...base, validation: { min: 'ten' } }, ctx))).toEqual([
      'validation:badLimit',
    ]);
    expect(codes(validateFieldDraft({ ...base, validation: { min: '5', max: '1' } }, ctx))).toEqual(
      ['validation:badLimit'],
    );
    expect(
      codes(validateFieldDraft({ ...base, validation: { minLength: 4, maxLength: 2 } }, ctx)),
    ).toEqual(['validation:badLimit']);
    expect(codes(validateFieldDraft({ ...base, validation: { minLength: -1 } }, ctx))).toEqual([
      'validation:badLimit',
    ]);
  });

  it('refuses an unknown kind and a width that is not positive', () => {
    expect(codes(validateFieldDraft({ ...base, kind: 'attachment' }, ctx))).toEqual([
      'kind:unknownKind',
    ]);
    expect(codes(validateFieldDraft({ ...base, width: 0 }, ctx))).toEqual(['width:badWidth']);
    expect(validateFieldDraft({ ...base, width: null }, ctx)).toEqual([]);
  });

  it('reports every reason at once, each with its property (property)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...FIELD_KINDS), fc.boolean(), (kind, dupKey) => {
        const draft = { ...base, kind, key: dupKey ? 'landlord.name' : 'x', assignee: 'nope' };
        const problems = validateFieldDraft(draft, ctx);
        expect(problems.map((p) => p.code)).toContain('assigneeNotRole');
        expect(problems.some((p) => p.code === 'duplicateKey') === dupKey).toBe(true);
        expect(canCommitField(problems)).toBe(false);
      }),
    );
  });

  it('never reports a key of its own field as a duplicate (property)', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 12 }), (key) => {
        fc.pre(key.trim() !== '');
        const problems = validateFieldDraft(
          { ...base, key },
          { otherKeys: [], roles: ['role_tenant'] },
        );
        expect(problems.some((p) => p.code === 'duplicateKey')).toBe(false);
      }),
    );
  });
});

describe('a commit is ordinary attribute changes (FRW-073, criterion 3)', () => {
  it('patches only the properties that changed', () => {
    const edited: FieldDraft = { ...base, label: 'Income', required: false, width: 2400 };
    expect(fieldPatch(base, edited)).toEqual({ label: 'Income', required: false, width: 2400 });
  });

  it('is empty when nothing changed, whatever the key order of nested objects', () => {
    const reordered: FieldDraft = {
      ...base,
      format: { prefix: 'EUR', decimals: 2 },
      validation: { max: '1000000', min: '0' },
    };
    expect(fieldPatch(base, reordered)).toEqual({});
  });

  it('never patches sensitive, which the panel does not offer (property)', () => {
    expect(FIELD_PROPERTIES).not.toContain('sensitive' as never);
    fc.assert(
      fc.property(fc.boolean(), fc.string(), (required, label) => {
        const patch = fieldPatch(base, { ...base, required, label });
        expect(
          Object.keys(patch).every((k) => (FIELD_PROPERTIES as readonly string[]).includes(k)),
        ).toBe(true);
      }),
    );
  });
});

describe('the panel is read-only without edit or during a running workflow (FRW-073, criterion 4)', () => {
  it('is read-only for a user without edit, whatever the workflow', () => {
    fc.assert(
      fc.property(fc.constantFrom('draft', 'sent', 'in_progress', 'completed', null), (wf) => {
        expect(fieldPanelReadOnly(false, wf)).toBe(true);
      }),
    );
  });

  it('is read-only while the workflow is sent or in progress, and editable otherwise', () => {
    expect(fieldPanelReadOnly(true, 'sent')).toBe(true);
    expect(fieldPanelReadOnly(true, 'in_progress')).toBe(true);
    expect(fieldPanelReadOnly(true, 'draft')).toBe(false);
    expect(fieldPanelReadOnly(true, null)).toBe(false);
  });
});
