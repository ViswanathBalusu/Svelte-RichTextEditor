// The panel's form model (FRW-073; shell/field-form.ts): a draft shown as the inputs' text reads back
// to the same draft, and text that is not a JSON object or a number is reported, not guessed.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { draftFromForm, formFromDraft } from '../src/shell/field-form.ts';
import type { FieldDraft } from '../src/shell/field-properties.ts';

const DRAFT: FieldDraft = {
  key: 'tenant.amount',
  kind: 'choice',
  label: 'Pets',
  assignee: 'role_tenant',
  required: true,
  readOnly: false,
  default: 'no',
  placeholder: null,
  options: [
    { id: 'yes', label: 'Yes' },
    { id: 'no', label: 'No, thanks' },
  ],
  format: { decimals: 2 },
  validation: { minLength: 1, maxLength: 10 },
  width: 96,
};

describe('the properties panel form model (FRW-073)', () => {
  it('reads back to the same draft it was shown from', () => {
    const { draft, jsonErrors } = draftFromForm(formFromDraft(DRAFT));
    expect(jsonErrors).toEqual([]);
    expect(draft).toEqual(DRAFT);
  });

  it('round-trips every draft with a role, options and limits (property)', () => {
    const word = fc.stringMatching(/^[a-z][a-z0-9_.]{0,11}$/);
    const option = fc.record({ id: word, label: word });
    fc.assert(
      fc.property(
        fc.record({
          key: word,
          kind: fc.constantFrom('text', 'number', 'choice'),
          label: word,
          assignee: fc.option(word, { nil: null }),
          required: fc.boolean(),
          readOnly: fc.boolean(),
          default: fc.option(word, { nil: null }),
          placeholder: fc.option(word, { nil: null }),
          options: fc.uniqueArray(option, {
            maxLength: 3,
            selector: (o) => o.id,
          }),
          format: fc.constant(null),
          validation: fc.option(fc.record({ maxLength: fc.nat({ max: 99 }) }), { nil: null }),
          width: fc.option(fc.integer({ min: 1, max: 5000 }), { nil: null }),
        }),
        (d) => {
          const back = draftFromForm(formFromDraft(d)).draft;
          expect(back.options).toEqual(d.options.map((o) => ({ id: o.id, label: o.label })));
          expect(back).toEqual({ ...d, options: back.options });
        },
      ),
      { numRuns: 100 },
    );
  });

  it('reports text that is not a JSON object, and keeps it out of the draft', () => {
    const form = { ...formFromDraft(DRAFT), validation: '[1, 2]', format: '{broken' };
    const { draft, jsonErrors } = draftFromForm(form);
    expect(jsonErrors).toEqual(['format', 'validation']);
    expect(draft.validation).toBeNull();
    expect(draft.format).toBeNull();
  });

  it('a width that is not a number is NaN, which the gate refuses', () => {
    const { draft } = draftFromForm({ ...formFromDraft(DRAFT), width: 'wide' });
    expect(Number.isNaN(draft.width)).toBe(true);
  });

  it('an option line without a bar is its own label; blank lines are ignored', () => {
    const { draft } = draftFromForm({ ...formFromDraft(DRAFT), options: 'a\n\n b | Bee ' });
    expect(draft.options).toEqual([
      { id: 'a', label: 'a' },
      { id: 'b', label: 'Bee' },
    ]);
  });
});
