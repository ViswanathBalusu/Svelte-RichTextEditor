// Editing rights and fill rights together in the outcome check (12 §4.3; FRW-011): an editor in a
// draft may change any attribute of a field, a suggester without `edit` may change no field, an
// approved region or a lease does not block a fill by the field's role, and a fill that comes with
// a text change is refused as a whole. Criterion 4 of FRW-011 (an approved region refuses an edit of
// another attribute) is not tested here: the outcome check does not enforce 07 §11 for regions (see
// the story's Notes).
import { Fragment, type Node, Slice } from 'prosemirror-model';
import { AttrStep, ReplaceStep, type Step } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { posInside, posOf } from './fixtures.ts';
import {
  FIELDS,
  USERS,
  fieldsDoc,
  morePermissions,
  refused,
  schema,
  verdictOf,
} from './permission-fixtures.ts';

const setAttr =
  (id: string, attr: string, value: unknown) =>
  (doc: Node): Step[] => [new AttrStep(posOf(doc, id), attr, value)];
const fill = (id: string, value: unknown) => setAttr(id, 'value', value);
const all =
  (...makers: Array<(doc: Node) => Step[]>) =>
  (doc: Node): Step[] =>
    makers.flatMap((m) => m(doc));

const LENA = {
  sub: 'lena',
  session: 's-lena',
  role: 'filler' as const,
  groups: [],
  participantRoles: ['role_landlord'],
  participantActive: true,
};

describe('FRW-011 an editor in a draft changes any attribute of a field', () => {
  it('accepts a change of key, label, assignee, required and width, and of the value', () => {
    const doc = fieldsDoc();
    const verdict = verdictOf(
      USERS.carol,
      doc,
      all(
        setAttr(FIELDS.number, 'label', 'Monthly rent'),
        setAttr(FIELDS.number, 'required', true),
        setAttr(FIELDS.number, 'width', 2880),
        setAttr(FIELDS.number, 'assignee', 'role_landlord'),
        fill(FIELDS.number, '12.50'),
      ),
    );
    expect(verdict.ok).toBe(true);
  });
});

describe('FRW-011 a suggester without edit changes no field', () => {
  it('refuses a value change and an attribute change of a field', () => {
    const doc = fieldsDoc();
    const byValue = verdictOf(USERS.dave, doc, fill(FIELDS.number, '12.50'));
    expect(byValue.ok).toBe(false);
    expect(refused(byValue)).toContain(`field:${FIELDS.number}`);

    const byAttr = verdictOf(USERS.dave, doc, setAttr(FIELDS.number, 'required', true));
    // An attribute other than the value is not a value change, so the refusal names the body that
    // holds the field (P4 refuses the suggestion; no suggestion rule accepts an attribute change).
    expect(byAttr.ok).toBe(false);
    expect(refused(byAttr)).toContain('body');
  });
});

describe('FRW-011 approval and leases do not block a fill by the field role', () => {
  it('accepts a fill of a field in an approved region that a lease holds', () => {
    const perms = morePermissions({
      regionStates: new Map([['rTerms000000000A', 'approved']]),
      leases: [{ region: 'rTerms000000000A', holder: 'rita', expiresAt: 1e15 }],
    });
    const doc = fieldsDoc();
    const verdict = verdictOf(LENA, doc, fill(FIELDS.termsSecret, 'SECRET-RENT-2'), { perms });
    expect(verdict.ok).toBe(true);
  });
});

describe('FRW-011 a fill and a text change in one step list are refused as a whole', () => {
  it('refuses the whole commit when the submitter has only fill', () => {
    const doc = fieldsDoc();
    const at = posInside(doc, 'pFields00000001X');
    const insert = (_d: Node): Step[] => [
      new ReplaceStep(at, at, new Slice(Fragment.from(schema.text('x')), 0, 0)),
    ];
    // The fill alone is accepted, so the refusal below is caused by the text change.
    expect(verdictOf(USERS.erin, doc, fill(FIELDS.number, '12.50')).ok).toBe(true);
    const verdict = verdictOf(USERS.erin, doc, all(fill(FIELDS.number, '12.50'), insert));
    expect(verdict.ok).toBe(false);
    expect(refused(verdict)).toContain('body');
  });
});
