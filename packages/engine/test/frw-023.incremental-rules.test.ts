/**
 * FRW-023 criterion 6, in Node.js (lane w4): when a person types in a field, the editor evaluates only
 * the fields whose state the change can change, and the states it ends with are the ones a full
 * evaluation of the same document gives. The document at the limits of 12 §5.1 (2,000 fields and 500
 * rules) is `frw-023-scale-fixture.ts`; the time a keystroke takes in a browser is measured in
 * `src/view/frw-023-rules-scale.universal.test.ts`.
 */
import { EditorState } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { FieldRules } from '../src/field-rules.ts';
import { editingSchema } from '../src/schema.ts';
import { RULE_FIELD_IDS, ruleDocument } from './frw-023-fixture.ts';
import { scaleDocument, scaleId, SCALE_FIELDS, SCALE_RULES } from './frw-023-scale-fixture.ts';

/** A document held as editor state, with a way to change one field's value or its text. */
function held(envelope: unknown, roles: string[] = ['role_tenant']) {
  let state = EditorState.create({
    doc: editingSchema().nodeFromJSON((envelope as { doc: unknown }).doc),
  });
  const rules = new FieldRules({ state: () => state, roles: () => roles });
  const position = (id: string): number => {
    let at = -1;
    state.doc.descendants((n, pos) => {
      if (at < 0 && n.type.name === 'form_field' && n.attrs['id'] === id) at = pos;
      return at < 0;
    });
    if (at < 0) throw new Error(`no field ${id}`);
    return at;
  };
  return {
    rules,
    roles,
    state: () => state,
    set(id: string, value: unknown) {
      state = state.apply(state.tr.setNodeAttribute(position(id), 'value', value));
    },
    setAttr(id: string, name: string, value: unknown) {
      state = state.apply(state.tr.setNodeAttribute(position(id), name, value));
    },
    /** Types a character at the start of the first paragraph of the body, which holds no field. */
    typeText() {
      const body = state.doc.child(1).type.name === 'body' ? state.doc.child(0).nodeSize : 0;
      state = state.apply(state.tr.insertText('x', body + 2));
    },
    /** What a full evaluation of the document as it stands gives. */
    fresh() {
      return new FieldRules({ state: () => state, roles: () => roles }).states();
    },
  };
}

/** A small deterministic generator, so that a failure can be repeated. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('the rules are evaluated for the fields a change concerns (FRW-023 criterion 6)', () => {
  it('evaluates the changed field and the field its rule names, and nothing else', () => {
    const h = held(scaleDocument());
    h.rules.states();
    // The 2,000 fields of the fixture and the four of the contract it extends.
    expect(h.rules.stats).toMatchObject({ evaluations: 1, full: 1, lastFields: SCALE_FIELDS + 4 });
    expect(SCALE_RULES).toBe(500);

    // Rule 7 reads s.f0007 and hides s.f1007: two fields, with no new compilation.
    h.set(scaleId(7), 'hide');
    expect(h.rules.of(scaleId(1007))).toMatchObject({ visible: false });
    expect(h.rules.stats).toMatchObject({ evaluations: 2, full: 1, lastFields: 2 });

    // And the rule that no longer holds shows it again.
    h.set(scaleId(7), 'show');
    expect(h.rules.of(scaleId(1007))).toMatchObject({ visible: true });
    expect(h.rules.stats).toMatchObject({ evaluations: 3, full: 1, lastFields: 2 });

    // A field no rule reads is only itself.
    h.set(scaleId(1700), 'anything');
    h.rules.states();
    expect(h.rules.stats).toMatchObject({ full: 1, lastFields: 1 });
  });

  it('evaluates nothing when the text of the document changes and the fields do not', () => {
    const h = held(scaleDocument());
    const before = h.rules.states();
    const evaluations = h.rules.stats.evaluations;
    h.typeText();
    expect(h.rules.states()).toBe(before);
    expect(h.rules.stats).toMatchObject({ evaluations, lastFields: 0 });
  });

  it('starts again when a field or a definition changes, and when the roles do', () => {
    const h = held(scaleDocument());
    h.rules.states();
    // A change of what the rules read of a field (here its kind) compiles them again.
    h.setAttr(scaleId(3), 'required', true);
    h.rules.states();
    expect(h.rules.stats.full).toBe(2);
    expect(h.rules.of(scaleId(3))).toMatchObject({ required: true });

    // Other roles evaluate every field again with the rules as compiled.
    h.roles.splice(0, h.roles.length, 'role_landlord');
    h.set(scaleId(9), 'x');
    h.rules.states();
    expect(h.rules.stats).toMatchObject({ full: 2, lastFields: SCALE_FIELDS + 4 });
  });

  it('ends with the states a full evaluation gives, after any run of changes', () => {
    for (const [name, envelope, ids] of [
      [
        'the rules at their limits',
        scaleDocument(),
        (r: () => number) => scaleId(Math.floor(r() * 1100)),
      ],
      [
        'the rules of the fixture of FRW-023',
        ruleDocument(),
        (r: () => number) =>
          Object.values(RULE_FIELD_IDS).filter((id) => id !== RULE_FIELD_IDS.total)[
            Math.floor(r() * 6)
          ]!,
      ],
    ] as const) {
      const h = held(envelope);
      h.rules.states();
      const next = random(2026);
      const values = ['hide', 'show', 'Ada', 'Bob', '5', '10', '99', ''];
      for (let step = 0; step < 40; step++) {
        const id = ids(next);
        const value = values[Math.floor(next() * values.length)]!;
        try {
          h.set(id, value === '' ? null : value);
        } catch {
          continue;
        }
        expect(h.rules.states(), `${name}, step ${step}`).toEqual(h.fresh());
      }
    }
  });
});
