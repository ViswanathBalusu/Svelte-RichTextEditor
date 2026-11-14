// Values derived from a hidden value are hidden in a reader's projection too (FRW-089 criterion 1,
// part: a rule's `set` target computed from a sensitive value). The rule closure comes from
// `@docedit/rules` (`derivedFromHidden`); this test checks that the authority's projection redacts
// the derived field once its id is in the hidden set, and that without the closure the derived
// value leaks. It does not cover mirrors, computed labels, `cached` text, the server evaluation or
// the sealed PDF: those stay unticked (see the story's Notes).
import { derivedFromHidden } from '../../rules/src/hidden.ts';
import { type FieldInfo, compileRules, rulesFromList, type RuleSet } from '@docedit/rules';
import type { JsonValue } from '@docedit/model';
import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  type HiddenSet,
  project,
  projectionSchema,
} from '../src/projection/projection.ts';
import { BASE_JSON, schema } from './fixtures.ts';

const INCOME_ID = 'fIncomeSecret001';
const TOTAL_ID = 'fTotalDerived001';
const INCOME_VALUE = '4711';

// Rule keys are the form fields' `key` attributes. The income field is sensitive; the total is set by
// a rule from the income, so its stored value carries the income.
const FIELDS: FieldInfo[] = [
  { key: 'income', kind: 'number' },
  { key: 'total', kind: 'formula' },
];
const RULES: JsonValue[] = [
  {
    id: 'r_total',
    when: true,
    then: [{ set: { field: 'total', value: { sum: [{ field: 'income' }, '1'] } } }],
  },
];

function ruleSet(): RuleSet {
  const r = compileRules(rulesFromList(RULES), { fields: FIELDS, roles: [] });
  if (!r.ok) throw new Error(JSON.stringify(r.problems));
  return r.ruleSet;
}

// A document with the two fields in one paragraph, built from the authority's base fixture.
function doc() {
  const json = structuredClone(BASE_JSON) as unknown as {
    content: Array<{ type: string; content: Array<Record<string, unknown>> }>;
  };
  json.content[1]!.content.splice(1, 0, {
    type: 'paragraph',
    attrs: { id: 'pDerived0000001X' },
    content: [
      { type: 'text', text: 'Income: ' },
      {
        type: 'form_field',
        attrs: {
          id: INCOME_ID,
          key: 'income',
          kind: 'number',
          label: 'Income',
          assignee: 'role_tenant',
          sensitive: true,
          value: INCOME_VALUE,
        },
      },
      { type: 'text', text: ' Total: ' },
      {
        type: 'form_field',
        attrs: {
          id: TOTAL_ID,
          key: 'total',
          kind: 'formula',
          label: 'Total',
          assignee: 'role_tenant',
          sensitive: false,
          value: '4712',
        },
      },
    ],
  });
  const d = schema.nodeFromJSON(json);
  d.check();
  return d;
}

// The value a reader sees for one field id in a projection.
function visibleValue(hiddenIds: ReadonlySet<string>, id: string): unknown {
  const hidden: HiddenSet = { regions: new Set(), values: hiddenIds, titles: false };
  const p = project(doc(), hidden, projectionSchema());
  let found: unknown = undefined;
  p.doc.descendants((n) => {
    if (n.type.name === 'form_field' && n.attrs['id'] === id) found = n.attrs['value'];
    return found === undefined;
  });
  return found;
}

describe('a value derived from a hidden value is hidden too (FRW-089 criterion 1, rules part)', () => {
  it('redacts the derived field once the rule closure of the hidden field is hidden', () => {
    const closure = derivedFromHidden(ruleSet(), ['income']);
    expect(closure.derived).toEqual(['total']);
    // The rule keys are the fields' `key` attributes; the projection hides by identifier.
    const ids = new Set([INCOME_ID, TOTAL_ID]);
    expect(visibleValue(ids, INCOME_ID)).toEqual(REDACTED);
    expect(visibleValue(ids, TOTAL_ID)).toEqual(REDACTED);
  });

  it('leaks the derived value if only the sensitive field is hidden (why the closure is needed)', () => {
    expect(visibleValue(new Set([INCOME_ID]), INCOME_ID)).toEqual(REDACTED);
    expect(visibleValue(new Set([INCOME_ID]), TOTAL_ID)).toBe('4712');
  });

  it('shows both values to a reader with no hidden set (control)', () => {
    expect(visibleValue(new Set(), INCOME_ID)).toBe(INCOME_VALUE);
    expect(visibleValue(new Set(), TOTAL_ID)).toBe('4712');
  });
});
