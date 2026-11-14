// The authority-side checks of a participant's completion (12 §5.3, §8.1 step 4; FRW-047): the
// required and validation checks of the participant's own visible fields, and the hidden values
// the completion commit clears.
import fc from 'fast-check';
import type { Node } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { completionCheck, hiddenValuesToClear } from '../src/workflow/completion.ts';
import { FIELDS, fieldsJson, schema } from './permission-fixtures.ts';

type J = Record<string, unknown>;

/** The fixture document with `patch` applied to the attributes of the fields named by id. */
function docWith(patch: Partial<Record<keyof typeof FIELDS, J>>): Node {
  const json = structuredClone(fieldsJson()) as unknown as { content: Array<{ content: J[] }> };
  const walk = (n: J): void => {
    const attrs = n['attrs'] as J | undefined;
    if (n['type'] === 'form_field' && attrs) {
      for (const [name, extra] of Object.entries(patch)) {
        if (attrs['id'] === FIELDS[name as keyof typeof FIELDS] && extra)
          Object.assign(attrs, extra);
      }
    }
    for (const c of (n['content'] as J[] | undefined) ?? []) walk(c);
  };
  for (const top of json.content) walk(top as unknown as J);
  const doc = schema.nodeFromJSON(json);
  doc.check();
  return doc;
}

const TENANT = ['role_tenant'];
const LANDLORD = ['role_landlord'];

describe('a participant completes when their own fields pass (FRW-047)', () => {
  it('passes when no field the participant owns is required or invalid', () => {
    expect(completionCheck(fieldsDocPlain(), TENANT)).toEqual({ ok: true });
  });

  it('refuses a required empty field and names its key and the required rule', () => {
    const doc = docWith({ number: { required: true } });
    const v = completionCheck(doc, TENANT);
    expect(v).toEqual({
      ok: false,
      problems: [
        {
          key: 'tenant.amount',
          id: FIELDS.number,
          code: 'required',
          message: 'this field is required',
        },
      ],
    });
  });

  it('accepts the required field once it holds a value of its kind', () => {
    const doc = docWith({ number: { required: true, value: '12.50' } });
    expect(completionCheck(doc, TENANT)).toEqual({ ok: true });
  });

  it('refuses a stored value that fails a static validation, naming the validation', () => {
    const doc = docWith({ readOnly: { validation: { maxLength: 3 }, value: 'too long' } });
    const v = completionCheck(doc, TENANT);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.problems.map((p) => [p.key, p.code])).toEqual([['tenant.fixed', 'max_length']]);
    }
  });

  it('checks only the fields assigned to the participant roles', () => {
    const doc = docWith({ landlord: { required: true } });
    expect(completionCheck(doc, TENANT)).toEqual({ ok: true });
    const v = completionCheck(doc, LANDLORD);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.problems.map((p) => p.key)).toEqual(['landlord.name']);
  });

  it('lists each unfilled required field of the participant and no other (property)', () => {
    const ids = [FIELDS.number, FIELDS.date] as const;
    fc.assert(
      fc.property(fc.array(fc.boolean(), { minLength: 2, maxLength: 2 }), (filled) => {
        const patch: Partial<Record<keyof typeof FIELDS, J>> = {
          number: { required: true, value: filled[0] ? '1.00' : null },
          date: { required: true, value: filled[1] ? '2026-11-30' : null },
        };
        const v = completionCheck(docWith(patch), TENANT);
        const expected = ids.flatMap((id, i) => (filled[i] ? [] : [id]));
        if (expected.length === 0) return v.ok === true;
        return (
          !v.ok &&
          v.problems
            .map((p) => p.id)
            .sort()
            .join() === [...expected].sort().join()
        );
      }),
      { numRuns: 100 },
    );
  });
});

describe('the completion commit clears the values of hidden fields (FRW-047)', () => {
  it('lists the hidden fields that hold a value and no others', () => {
    const doc = docWith({ landlord: { value: 'Lena' }, number: { value: '3.00' } });
    const evaluation = {
      fields: [
        { key: 'landlord.name', visible: false },
        { key: 'tenant.amount', visible: true },
        { key: 'tenant.moveIn', visible: false },
      ],
    };
    expect(hiddenValuesToClear(doc, evaluation)).toEqual(['landlord.name']);
  });
});

/** The fixture document with no changes: the plain fields, none required, none stored invalid. */
function fieldsDocPlain(): Node {
  const doc = schema.nodeFromJSON(fieldsJson());
  doc.check();
  return doc;
}
