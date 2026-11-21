// FRW-015 criterion 4, the editor's part: the published rules fixtures, judged through the editor's
// own use of the shared package. `FieldRules` (field-rules.ts) is what the editing core asks for the
// state of every field while a person fills; it imports `@docedit/rules` and nothing else evaluates
// a rule in the editor. Each `rules` case of the fixtures becomes a document in the editing schema,
// and what `FieldRules` says of its fields must be what the case expects: visible, enabled,
// required, the messages, and the computed value.
//
// The same cases are judged through the authority (`packages/authority/test/frw-020.fixtures.test.ts`)
// and through the authority service (`services/authority-service/test/frw-020.identical-results.test.ts`
// and `frw-015.wire-fixtures.test.ts`). This file runs in Node.js and, through `pnpm test:browsers`,
// in Chromium, Firefox and WebKit: the editor's engines.
//
// What the editor does not give, and so is not compared here: the rule that decided each state
// (`by`), the outcome of each rule, and a formula's error code; the editor shows states only. The
// editor reads no clock, so the case that gives an instant is evaluated without one and is left out.
import { RULES_VERSION, type FixtureCase, type StateExpect } from '@docedit/rules';
import { FIXTURES } from '@docedit/rules/fixtures';
import { beforeAll, describe, expect, it } from 'vitest';
import { FieldRules, type FieldRuleState } from './field-rules.ts';
import { editingSchema } from './schema.ts';
import { loadParts } from './parts.ts';

// The rules language and the authoring checks load on first use (FND-008; engine parts.ts).
beforeAll(() => loadParts(['authoring', 'rules']));

type RulesCase = Extract<FixtureCase, { kind: 'rules' }>;
type J = Record<string, unknown>;

const rulesCases = FIXTURES.cases.filter((c): c is RulesCase => c.kind === 'rules');
const positive = rulesCases.filter((c) => 'fields' in c.expect);
const negative = rulesCases.filter((c) => 'problems' in c.expect);

const fieldId = (i: number): string => `fFx${String(i).padStart(13, '0')}`;

/** The case as a document of the editing schema: roles and rules in the definitions, fields in the body. */
function documentOf(c: RulesCase) {
  const defs: J[] = [
    { type: 'settings', attrs: { lang: 'en-GB' } },
    {
      type: 'style_def',
      attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal', builtIn: true },
    },
    { type: 'page_setup', attrs: { id: 'ps1' } },
  ];
  for (const role of c.given?.roleDefs ?? [])
    defs.push({ type: 'role_def', attrs: { id: role, name: role, color: '#000000' } });
  for (const rule of c.rules) defs.push({ type: 'rule_def', attrs: rule as J });
  const values = c.given?.values ?? {};
  const fields = (c.given?.fields ?? []).map((f, i) => ({
    type: 'form_field',
    attrs: {
      id: fieldId(i),
      key: f.key,
      kind: f.kind,
      label: f.key,
      assignee: null,
      value: values[f.key] ?? null,
      ...(f.options ? { options: f.options.map((o) => ({ id: o, label: o })) } : {}),
      ...(f.required ? { required: true } : {}),
      ...(f.readOnly ? { readOnly: true } : {}),
      ...(f.validation ? { validation: f.validation } : {}),
    },
  }));
  return editingSchema().nodeFromJSON({
    type: 'doc',
    content: [
      { type: 'defs', content: defs },
      {
        type: 'body',
        attrs: { pageSetup: 'ps1' },
        content: [
          {
            type: 'paragraph',
            attrs: { id: 'pOne000000000001', style: 'Normal' },
            content: fields.flatMap((f) => [{ type: 'text', text: ' ' }, f]),
          },
        ],
      },
    ],
  });
}

/** The editor's states for a case, by field key. */
function editorStates(c: RulesCase): Map<string, FieldRuleState> {
  const doc = documentOf(c);
  const rules = new FieldRules({ state: () => ({ doc }), roles: () => c.given?.roles ?? [] });
  const byId = rules.states();
  const out = new Map<string, FieldRuleState>();
  (c.given?.fields ?? []).forEach((f, i) => {
    const s = byId.get(fieldId(i));
    if (s) out.set(f.key, s);
  });
  return out;
}

describe('the rules fixtures through the editor (FRW-015 criterion 4)', () => {
  it('reads the published set of this rules version', () => {
    expect(FIXTURES.rules).toBe(RULES_VERSION);
    expect(positive.length).toBe(31);
    expect(negative.length).toBe(37);
  });

  it('gives every field of every case the state the fixture expects', () => {
    let fields = 0;
    let instant = 0;
    let withoutRules = 0;
    for (const c of positive) {
      // The editor reads no clock: a case that gives an instant is not the editor's to judge.
      if (c.given?.now) {
        instant++;
        continue;
      }
      const states = editorStates(c);
      const expected = (c.expect as { fields: Record<string, StateExpect> }).fields;
      if (c.rules.length === 0) {
        // No rule: the editor keeps no state and shows what the field itself says.
        expect(states.size, c.id).toBe(0);
        withoutRules++;
        continue;
      }
      for (const [key, want] of Object.entries(expected)) {
        const got = states.get(key);
        expect(got, `${c.id}: ${key}`).toBeDefined();
        if (!got) continue;
        expect(
          {
            visible: got.visible,
            enabled: got.enabled,
            required: got.required,
            messages: [...got.messages],
            ...('value' in want ? { value: got.value } : {}),
          },
          `${c.id}: ${key}`,
        ).toEqual({
          visible: want.visible,
          enabled: want.enabled,
          required: want.required,
          messages: (want.messages ?? []).map((m) => m.message),
          ...('value' in want ? { value: want.value ?? null } : {}),
        });
        // A formula field is shown as computed, and only a formula field.
        expect(got.computed, `${c.id}: ${key} computed`).toBe(
          'value' in want || want.error !== undefined,
        );
        fields++;
      }
    }
    // The comparison is not empty, and the one case left out is the one named above.
    expect(fields).toBeGreaterThan(60);
    expect({ instant, withoutRules }).toEqual({ instant: 1, withoutRules: 0 });
  });

  it('keeps no state for a set of rules that does not compile: the authority gives the verdict', () => {
    for (const c of negative) expect(editorStates(c).size, c.id).toBe(0);
  });
});
