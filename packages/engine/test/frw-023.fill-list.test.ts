/**
 * FRW-023 criterion 6, in Node.js (lane w4): what a change of one value costs the list of fields
 * that the guided bar, the fill pane and the progress event read (`fillFields()`).
 *
 * - The list is the same object until the document, a kept entry or a rule state changes, so a
 *   second reader after the same change pays nothing.
 * - After a change of one value, the item of every field that did not change is the same object:
 *   in the document at the limits of 12 §5.1 (2,000 fields and 500 rules) only the field that was
 *   filled and the field its rule names are made again.
 * - The list is always the one a reading of each field by itself gives (`fieldEntry`,
 *   `fieldRuleState`), after any run of entries, changes by someone else, undo, and changes of a
 *   field's definition or of a role.
 *
 * The time a keystroke takes in a browser is measured on the reference profile by
 * `packages/perf/e2e/frw-023-fill-typing.harness.spec.ts`.
 */
import type { JsonValue } from '@docedit/model';
import { beforeAll, describe, expect, it } from 'vitest';
import type { FieldStatus } from '../src/field-entries.ts';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { RULE_FIELD_IDS, ruleDocument } from './frw-023-fixture.ts';
import { SCALE_FIELDS, scaleDocument, scaleId } from './frw-023-scale-fixture.ts';
import { participantAccess } from './frw-fields-fixture.ts';
import { microtask, posOf } from './support.ts';
import { loadParts } from '../src/parts.ts';

// The rules language and the authoring checks load on first use (FND-008; engine parts.ts).
beforeAll(() => loadParts(['authoring', 'rules']));

const FORMAT = new Set(['type', 'pattern', 'preset', 'not_an_option']);
const RANGE = new Set(['min', 'max', 'min_length', 'max_length', 'too_large']);

/** The list as a reading of each field by itself gives it: no list is kept between two calls. */
function byField(core: DocumentCore): FieldStatus[] {
  const roles = new Map(core.roles().map((r) => [r.id, r]));
  const out: FieldStatus[] = [];
  for (const { id } of core.formFields()) {
    const entry = core.fieldEntry(id);
    const props = core.fieldProperties(id);
    if (!entry || !props) continue;
    const empty =
      entry.value === null ||
      (entry.kind === 'checkbox' && entry.value === false) ||
      ((entry.kind === 'text' || entry.kind === 'formula') && entry.value === '');
    const code = entry.problems[0]?.code;
    const own: FieldStatus['invalid'] =
      code === undefined ? null : FORMAT.has(code) ? 'format' : RANGE.has(code) ? 'range' : 'other';
    const assignee =
      typeof props.assignee === 'string' && props.assignee !== '' ? props.assignee : null;
    const role = assignee === null ? undefined : roles.get(assignee);
    const rule = core.fieldRuleState(id);
    out.push({
      id,
      key: entry.key,
      kind: entry.kind,
      label: entry.label ?? entry.key,
      required: rule === null ? entry.required : rule.visible ? rule.required : false,
      filled: !empty,
      invalid:
        rule === null
          ? own
          : !rule.visible
            ? null
            : (own ?? (rule.messages.length > 0 ? 'other' : null)),
      assignee,
      role: role ? { name: role.name, color: role.color, order: role.order } : null,
    });
  }
  return out;
}

/** A small deterministic generator, so that a failure can be repeated. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('the fill list after a change of one value (FRW-023 criterion 6)', () => {
  it('is the same list until something changes, at the limits of 2,000 fields and 500 rules', () => {
    const core = new DocumentCore({
      doc: scaleDocument(),
      access: participantAccess(['role_tenant']),
      mode: 'fill',
      schedule: microtask,
    });
    const first = core.fillFields();
    expect(first).toHaveLength(SCALE_FIELDS + 4);
    expect(core.fillFields()).toBe(first);
    expect(first).toEqual(byField(core));

    // One value: the field that was filled and the field its rule hides are made again; the item
    // of every other field is the object it was.
    expect(core.enterFieldValue(scaleId(7), 'hide')).toEqual({ ok: true, problems: [] });
    const second = core.fillFields();
    expect(second).not.toBe(first);
    expect(core.fillFields()).toBe(second);
    const changed = second.flatMap((item, i) => (item === first[i] ? [] : [item.id]));
    expect(changed.sort()).toEqual([scaleId(7), scaleId(1007)].sort());
    expect(second.find((f) => f.id === scaleId(7))).toMatchObject({ filled: true });
    expect(second).toEqual(byField(core));

    // A field no rule reads: one item.
    core.enterFieldValue(scaleId(1700), 'anything');
    const third = core.fillFields();
    expect(third.flatMap((item, i) => (item === second[i] ? [] : [item.id]))).toEqual([
      scaleId(1700),
    ]);
    expect(third).toEqual(byField(core));
    core.destroy();
  });

  it('keeps every item when the text of the document changes and no field does', () => {
    const core = new DocumentCore({ doc: scaleDocument(), schedule: microtask });
    const before = core.fillFields();
    const i = internals(core);
    // A character at the start of the paragraph that holds the first fields of the fixture.
    i.dispatch(i.state.tr.insertText('x', posOf(i.state.doc, 'pFields000000001') + 1));
    const after = core.fillFields();
    expect(after).toHaveLength(before.length);
    expect(after.every((item, n) => item === before[n])).toBe(true);
    core.destroy();
  });

  it('follows a kept entry that ends without a change of the document', () => {
    const core = new DocumentCore({ doc: ruleDocument(), schedule: microtask });
    const amount = RULE_FIELD_IDS.amount;
    const item = () => core.fillFields().find((f) => f.id === amount)!;
    core.enterFieldValue(amount, '50');
    expect(item()).toMatchObject({ filled: true, invalid: null });
    // Letters in a number field: the entry is submitted and kept.
    core.enterFieldValue(amount, 'abc');
    expect(item()).toMatchObject({ invalid: 'format' });
    // The stored value goes back, as when the authority drops the fill; the entry is still shown.
    const i = internals(core);
    i.dispatch(i.state.tr.setNodeAttribute(posOf(i.state.doc, amount), 'value', '50'));
    expect(core.fieldEntry(amount)).toMatchObject({ value: 'abc', stored: '50' });
    const kept = core.fillFields();
    expect(item()).toMatchObject({ invalid: 'format' });
    // The person enters the stored value again: no transaction, and the entry is valid.
    const doc = i.state.doc;
    expect(core.enterFieldValue(amount, '50')).toEqual({ ok: true, problems: [] });
    expect(internals(core).state.doc).toBe(doc);
    expect(core.fillFields()).not.toBe(kept);
    expect(item()).toMatchObject({ filled: true, invalid: null });
    expect(core.fillFields()).toEqual(byField(core));
    core.destroy();
  });

  it('is the list a reading of each field gives, after any run of changes', () => {
    const fillable = [
      RULE_FIELD_IDS.amount,
      RULE_FIELD_IDS.name,
      RULE_FIELD_IDS.email,
      RULE_FIELD_IDS.landlord,
      RULE_FIELD_IDS.spouse,
    ];
    const entries: JsonValue[] = [
      'Ada',
      'Bob',
      'A',
      'far too long',
      '5',
      '10',
      '99',
      '-1',
      'abc',
      'ada@example.org',
      'not an address',
      '',
      null,
      12,
    ];
    for (const seed of [1, 2026, 77]) {
      const core = new DocumentCore({ doc: ruleDocument(), schedule: microtask });
      const next = random(seed);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;
      expect(core.fillFields(), `seed ${seed}, start`).toEqual(byField(core));
      let kept = 0;
      for (let step = 0; step < 120; step++) {
        const action = next();
        const id = pick(fillable);
        if (action < 0.55) {
          // The person enters something; an entry with a problem is kept.
          const result = core.enterFieldValue(id, pick(entries));
          if (result.ok && result.problems.length > 0) kept++;
        } else if (action < 0.7) {
          // Someone else changes the stored value, which ends a kept entry of the field.
          const i = internals(core);
          i.dispatch(
            i.state.tr.setNodeAttribute(posOf(i.state.doc, id), 'value', pick(['Zoe', '7', null])),
          );
        } else if (action < 0.8) {
          core.run('undo');
        } else if (action < 0.92) {
          // The author changes the field's definition.
          core.editField(
            id,
            pick([
              { required: true },
              { required: false },
              { label: `Label ${step}` },
              { assignee: 'role_landlord' },
              { assignee: 'role_tenant' },
              { validation: null },
            ]),
          );
        } else {
          // The author renames a role: every field of the role shows the new name.
          core.editRole({
            op: 'update',
            id: 'role_tenant',
            values: { name: `Tenant ${step}`, color: '#1F77B4' },
          });
        }
        const list = core.fillFields();
        expect(list, `seed ${seed}, step ${step}`).toEqual(byField(core));
        // A second reading is the same object, with nothing made again.
        expect(core.fillFields(), `seed ${seed}, step ${step}, read twice`).toBe(list);
      }
      // The run met entries with problems, so the kept entries were part of what is compared.
      expect(kept, `seed ${seed}`).toBeGreaterThan(5);
      core.destroy();
    }
  });
});
