// The published rules fixtures run through the authority's rule gate (FRW-020 criterion 2; 12 §5.2,
// §10; 05 §9): for each `rules` case, the case's fields and values are put in a document, the
// case's rules are put in its definitions, and the gate that refuses a fill (`ruleGate`, P7) must
// agree with the expected visibility and enablement of every field the case names, and must name
// the rule that hid or disabled a field when the case says which rule did.
//
// The cases that the gate does not judge are counted and listed in the test output: cases with a
// `now` (the gate evaluates without an instant, as a fill's check does), and the negative cases
// whose rule set has problems (the authority refuses those commits in the invariants, I14).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateDoc } from '@docedit/model/validate';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RULE_BUDGET, RULE_INVARIANTS, ruleGate } from '../src/room/rules.ts';
import { BASE_JSON, REQUIRES, schema } from './fixtures.ts';

const FIXTURES = resolve(import.meta.dirname, '../../../spec/rules/rules-1.fixtures.json');

type J = Record<string, unknown>;

interface FixtureField {
  key: string;
  kind: string;
  options?: string[];
  required?: boolean;
  readOnly?: boolean;
}

interface StateExpect {
  visible: boolean;
  enabled: boolean;
  by?: { visible?: string; enabled?: string };
}

interface RulesFixture {
  id: string;
  kind: string;
  rules: J[];
  given?: {
    fields?: FixtureField[];
    values?: Record<string, unknown>;
    roleDefs?: string[];
    roles?: string[];
    now?: unknown;
  };
  expect: { fields?: Record<string, StateExpect>; problems?: unknown[] };
}

const fixtures = JSON.parse(readFileSync(FIXTURES, 'utf8')) as {
  cases: Array<{ kind: string } & Record<string, unknown>>;
};
const ruleCases = fixtures.cases.filter((c) => c['kind'] === 'rules') as unknown as RulesFixture[];

/** The field's node identifier in the document: stable for the case, unique in it. */
const fieldId = (i: number) => `fFx${String(i).padStart(13, '0')}`;

/**
 * The case as a CDM document: its rules and roles in the definitions, its fields in the body. The
 * shape follows the authority's own tests (`frw-022.rule-enforcement.test.ts`).
 */
function documentOf(c: RulesFixture) {
  const json = structuredClone(BASE_JSON) as unknown as { content: Array<{ content: J[] }> };
  const defs = json.content[0]!.content;
  const have = new Set(
    defs.filter((n) => n['type'] === 'role_def').map((n) => (n['attrs'] as J)['id']),
  );
  for (const role of c.given?.roleDefs ?? []) {
    if (!have.has(role))
      defs.push({ type: 'role_def', attrs: { id: role, name: role, color: '#000000' } });
  }
  for (const rule of c.rules) defs.push({ type: 'rule_def', attrs: rule });
  const intro = json.content[1]!.content[1]!;
  const content = (intro['content'] as J[] | undefined) ?? [];
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
    },
  }));
  intro['content'] = [...content, ...fields.flatMap((f) => [{ type: 'text', text: ' ' }, f])];
  const doc = schema.nodeFromJSON(json);
  doc.check();
  return { doc, fields };
}

const judged = ruleCases.filter(
  (c) => c.expect.fields !== undefined && (c.given?.now === undefined || c.given?.now === null),
);
/** The negative cases: a rule set with problems. The gate fails closed on them (P7). */
const negative = ruleCases.filter((c) => c.expect.problems !== undefined);
/** The one case with an instant: the gate evaluates without one, so it is not judged here. */
const withInstant = ruleCases.filter((c) => !judged.includes(c) && !negative.includes(c));

describe('the rules fixtures through the authority rule gate (FRW-020 criterion 2)', () => {
  it('splits every rules case into judged, negative and instant cases', () => {
    expect(judged.length + negative.length + withInstant.length).toBe(ruleCases.length);
    expect(judged.length).toBe(30);
    expect(negative.length).toBe(37);
    expect(withInstant.length).toBe(1);
  });

  it('refuses every field of a negative case, fail closed (P7)', () => {
    const open: string[] = [];
    for (const c of negative) {
      const { doc, fields } = documentOf(c);
      const gate = ruleGate(doc, c.given?.roles ?? [], DEFAULT_RULE_BUDGET);
      if (gate === null) continue;
      for (const f of fields) {
        if (gate.enabled(f.attrs['id'] as string, doc, f.attrs['key'] as string)) open.push(c.id);
      }
    }
    expect(open).toEqual([]);
  });

  it('agrees with the published expectations for every judged case', () => {
    const mismatches: string[] = [];
    let checks = 0;
    for (const c of judged) {
      const { doc, fields } = documentOf(c);
      const gate = ruleGate(doc, c.given?.roles ?? [], DEFAULT_RULE_BUDGET);
      for (const [key, exp] of Object.entries(c.expect.fields ?? {})) {
        const i = fields.findIndex((f) => f.attrs.key === key);
        if (i < 0) {
          mismatches.push(`${c.id}: no field ${key} in the case`);
          continue;
        }
        const id = fieldId(i);
        // A case without rules has no gate: nothing hides or disables a field.
        const actual = gate === null ? true : gate.enabled(id, doc, key);
        checks++;
        const wanted = exp.visible && exp.enabled;
        if (actual !== wanted)
          mismatches.push(`${c.id}: ${key} visible-and-enabled is ${actual}, expected ${wanted}`);
        const by = exp.by?.visible ?? exp.by?.enabled;
        if (!wanted && by !== undefined) {
          checks++;
          const named = gate?.ruleOf(id);
          if (named !== by)
            mismatches.push(`${c.id}: ${key} is refused by ${named}, expected ${by}`);
        }
      }
      if (gate !== null) {
        expect(gate.overrun, c.id).toBe(false);
      }
    }
    expect(mismatches, `${checks} checks`).toEqual([]);
    expect(checks).toBeGreaterThanOrEqual(70);
  });
});

describe('the negative rules fixtures on the commit path (owner decision 185; ADR 0340)', () => {
  /** The violation code the commit path gives to a problem code of the rules package. */
  const codeOf = (problem: string) =>
    problem === 'unknown_field'
      ? 'rule_unknown_key'
      : problem === 'cycle'
        ? 'rule_cycle'
        : problem === 'pattern_unsupported'
          ? 'pattern_unsupported'
          : problem === 'too_many_rules'
            ? 'too_many_rules'
            : 'rule_invalid';

  it('refuses every rule problem at save, with the problems the case lists', () => {
    const unrefused: string[] = [];
    const missing: string[] = [];
    for (const c of negative) {
      const { doc } = documentOf(c);
      const verdict = validateDoc(doc, REQUIRES, {
        retiredRegionIds: new Set<string>(),
        invariants: [RULE_INVARIANTS],
      });
      if (verdict.valid) {
        unrefused.push(c.id);
        continue;
      }
      const codes = new Set(verdict.violations.map((v) => v.code));
      for (const p of c.expect.problems as Array<{ code: string }>)
        // A missing or mistyped member (ad_shape) is refused by the model's own checks of the
        // attributes before the rules are read.
        if (p.code !== 'bad_shape' && !codes.has(codeOf(p.code)) && !codes.has('rule_invalid'))
          missing.push(`${c.id}: ${p.code}`);
    }
    // A member that is not an attribute of rule_def (12 §3.5) is dropped when the document is read,
    // so a document cannot hold it: the one case about such a member is not reachable on commit.
    expect(unrefused).toEqual(['rules.extra-member']);
    expect(missing).toEqual([]);
  });

  it('accepts every judged case, so a valid rule set is never refused', () => {
    const refused: string[] = [];
    for (const c of [...judged, ...withInstant]) {
      const { doc } = documentOf(c);
      const verdict = validateDoc(doc, REQUIRES, {
        retiredRegionIds: new Set<string>(),
        invariants: [RULE_INVARIANTS],
      });
      if (!verdict.valid)
        refused.push(`${c.id}: ${verdict.violations.map((v) => v.code).join(',')}`);
    }
    expect(refused).toEqual([]);
  });
});
