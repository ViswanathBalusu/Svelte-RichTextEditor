// Nobody changes a value they cannot read, whatever attribute they change (FRW-088 criterion 3, the
// authority half; ADR 0019 change 5). The fixture's `secret` field is sensitive, assigned to the
// landlord role, and Carol, an editor with no grant, cannot read its value. The outcome check must
// refuse every attribute change she makes to it. The editor's redacted display is FE-141's.
import fc from 'fast-check';
import { AttrStep } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { posOf } from './fixtures.ts';
import { FIELDS, USERS, fieldsDoc, verdictOf } from './permission-fixtures.ts';

// The attributes the fixture's field node carries. `id` is not a change; `sensitive` is refused for
// another reason (`field.sensitive` needs `manage`), so it is left to its own test.
// The attributes whose stored value is a string, a boolean or a number: their type is known, so a
// different value of the same type is a schema-valid change. Attributes stored as null or as an
// object are typed by the schema in ways a generic value cannot satisfy; the example test above
// covers `default` and `assignee`, and the schema check itself is `permission-fixtures`' business.
const CHANGEABLE = (node: { attrs: Record<string, unknown> }): string[] =>
  Object.entries(node.attrs)
    .filter(
      ([a, v]) =>
        a !== 'id' &&
        a !== 'sensitive' &&
        (typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number'),
    )
    .map(([a]) => a);

// A value of the attribute's own type that differs from the stored one, so the step is a change.
function differentValue(stored: unknown, suffix: string): unknown {
  if (typeof stored === 'boolean') return !stored;
  if (typeof stored === 'number') return stored + 1;
  return `\u0001${suffix}`;
}

describe('nobody changes a value they cannot read, for any attribute (FRW-088 criterion 3)', () => {
  it('refuses every attribute change by Carol to a sensitive field she cannot read', () => {
    const doc = fieldsDoc();
    const node = doc.nodeAt(posOf(doc, FIELDS.secret))!;
    const attrs = CHANGEABLE(node);
    expect(attrs).toEqual(expect.arrayContaining(['value', 'assignee', 'label']));
    fc.assert(
      fc.property(fc.constantFrom(...attrs), fc.string({ maxLength: 40 }), (attr, suffix) => {
        const next = differentValue(node.attrs[attr], suffix);
        const v = verdictOf(USERS.carol, doc, (d) => [
          new AttrStep(posOf(d, FIELDS.secret), attr, next),
        ]);
        expect(v.ok, attr).toBe(false);
        if (!v.ok) {
          expect(v.code, attr).toBe('permission_denied');
          expect(v.reason, attr).toMatch(/cannot change a field whose value you cannot read/);
          expect(v.scopes, attr).toContain(`field:${FIELDS.secret}`);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('lets a reader of the same value change it through the same attribute (control)', () => {
    const doc = fieldsDoc();
    expect(
      verdictOf(USERS.alice, doc, (d) => [
        new AttrStep(posOf(d, FIELDS.secret), 'label', 'Landlord income (renamed)'),
      ]).ok,
    ).toBe(true);
  });
});
