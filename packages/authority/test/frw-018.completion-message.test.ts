// FRW-018 criterion 4 at the authority: when a participant completes (FRW-047), a stored value that
// does not match its field's `validation.pattern` refuses the completion, and the problem carries
// the message the author gave (`validation.message`; owner decision 187 of 2026-11-15), marked as
// the author's so that the service sends it. The check is the rules package's, the one the editor
// runs; the route that answers it is tested in services/document-service.
import { validateDoc } from '@docedit/model/validate';
import type { Node } from 'prosemirror-model';
import { AttrStep } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { Room } from '../src/room/room.ts';
import { RULE_INVARIANTS } from '../src/room/rules.ts';
import { stepsToJson } from '../src/steps.ts';
import { completionCheck } from '../src/workflow/completion.ts';
import { REQUIRES, USERS, basePermissions, posOf } from './fixtures.ts';
import { FIELDS, fieldsJson, schema } from './permission-fixtures.ts';

type J = Record<string, unknown>;

const PATTERN = '[A-Z]{2}[0-9]{4}';
const MESSAGE = 'Enter two letters and four digits, such as AB1234.';
const LANDLORD = ['role_landlord'];

/** The fixture document with these attributes on the landlord's text field. */
function docWith(extra: J): Node {
  const json = structuredClone(fieldsJson());
  const walk = (n: J): void => {
    const attrs = n['attrs'] as J | undefined;
    if (n['type'] === 'form_field' && attrs?.['id'] === FIELDS.landlord)
      Object.assign(attrs, extra);
    for (const c of (n['content'] as J[] | undefined) ?? []) walk(c);
  };
  walk(json);
  const doc = schema.nodeFromJSON(json);
  doc.check();
  return doc;
}

describe('completion reports a pattern with the message the author gave (FRW-018 criterion 4)', () => {
  it('refuses a stored value that does not match, with the author’s message, marked as authored', () => {
    const doc = docWith({ validation: { pattern: PATTERN, message: MESSAGE }, value: 'ab12' });
    expect(completionCheck(doc, LANDLORD)).toEqual({
      ok: false,
      problems: [
        {
          key: 'landlord.name',
          id: FIELDS.landlord,
          code: 'pattern',
          message: MESSAGE,
          authored: true,
        },
      ],
    });
  });

  it('passes a stored value that matches, and an empty one', () => {
    for (const value of ['AB1234', null])
      expect(
        completionCheck(
          docWith({ validation: { pattern: PATTERN, message: MESSAGE }, value }),
          LANDLORD,
        ),
      ).toEqual({ ok: true });
  });

  it('keeps the wording of the rules package, unmarked, when the author gave no message', () => {
    const v = completionCheck(
      docWith({ validation: { pattern: PATTERN }, value: 'ab12' }),
      LANDLORD,
    );
    expect(v).toEqual({
      ok: false,
      problems: [
        {
          key: 'landlord.name',
          id: FIELDS.landlord,
          code: 'pattern',
          message: 'the entry does not have the expected form',
        },
      ],
    });
  });

  it('does not mark the other problems of the same field as the author’s', () => {
    const v = completionCheck(
      docWith({
        required: true,
        validation: { pattern: PATTERN, message: MESSAGE, maxLength: 3 },
        value: 'ab12',
      }),
      LANDLORD,
    );
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.problems.map((p) => [p.code, p.authored ?? false])).toEqual([
      ['max_length', false],
      ['pattern', true],
    ]);
  });

  it('is an attribute the commit path validates: the room stores the message, and refuses one outside its grammar', () => {
    const invariants = (extra: J) =>
      validateDoc(docWith(extra), REQUIRES, {
        retiredRegionIds: new Set<string>(),
        invariants: [RULE_INVARIANTS],
      }).violations;
    expect(invariants({ validation: { pattern: PATTERN, message: MESSAGE } })).toEqual([]);
    // A message outside its grammar is refused like any attribute (I11).
    const bad = invariants({ validation: { pattern: PATTERN, message: 'x'.repeat(256) } });
    expect(bad.map((v) => v.invariant)).toEqual(['I11']);
    expect(bad[0]!.path).toMatch(/\/validation\/message$/);

    // The same through the room: the author's commit that sets the message is stored.
    const initial = docWith({});
    let clock = 1_780_300_000_000;
    const room = new Room({
      schema,
      initial,
      requires: REQUIRES,
      log: [],
      perms: basePermissions(),
      initialRevision: 1,
      epoch: 1,
      incarnation: 'inc-1',
      now: () => ++clock,
    });
    room.open('a1', USERS.alice);
    let n = 0;
    const submit = (validation: J) => {
      const step = new AttrStep(posOf(initial, FIELDS.landlord), 'validation', validation);
      const id = `0192f0c4-7c3e-7000-8000-${(++n).toString(16).padStart(12, '0')}`;
      const fx = room.submit('a1', { id, base: room.head, steps: stepsToJson([step]) });
      const out = [...fx.send];
      if (fx.write) out.push(...room.writeCompleted({ status: 'ok' }).send);
      return out.filter((o) => o.channel === 'a1').map((o) => o.msg);
    };
    const refused = submit({ pattern: PATTERN, message: 'bell\u0007' });
    expect(refused.find((m) => m.t === 'sync.reject')).toMatchObject({ code: 'invalid_op' });
    expect(room.head).toBe(0);
    const stored = submit({ pattern: PATTERN, message: MESSAGE });
    expect(stored.some((m) => m.t === 'sync.ack')).toBe(true);
    expect(room.head).toBe(1);
    expect(room.document.nodeAt(posOf(initial, FIELDS.landlord))!.attrs['validation']).toEqual({
      pattern: PATTERN,
      message: MESSAGE,
    });
  });
});
