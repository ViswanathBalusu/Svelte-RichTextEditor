// A value the rules compute from a value a reader may not see is hidden from that reader too
// (FRW-089 criterion 1, rules part, wired into the authority's visibility). The hidden set of a
// connection now includes the closure of its unreadable keys under the document's own rules. This
// test drives `hiddenSet` and the projection on a document whose rules are stored in its definitions.
// It does not cover mirrors, computed labels, `cached` text, the server evaluation or the sealed PDF.
import type { JsonValue } from '@docedit/model';
import type { Node } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { hiddenSet } from '../src/permissions/visibility.ts';
import { REDACTED, project, projectionSchema } from '../src/projection/projection.ts';
import { BASE_JSON, USERS, basePermissions, schema } from './fixtures.ts';

const NOW = 1_760_000_000_000;
const INCOME_ID = 'fIncomeSecret009';
const TOTAL_ID = 'fTotalDerived009';
const INCOME_VALUE = '4711';
const TOTAL_VALUE = '4712';

const SUM_RULE: JsonValue = {
  id: 'r_total',
  when: true,
  then: [{ set: { field: 'total', value: { sum: [{ field: 'income' }, '1'] } } }],
};

type J = Record<string, unknown>;

/** The base document: the income field (sensitive) and the total it drives, plus the rules. */
function docWith(rules: JsonValue[], income: J = { sensitive: true }): Node {
  const json = structuredClone(BASE_JSON) as unknown as {
    content: Array<{ content: J[] }>;
  };
  json.content[0]!.content.push(...rules.map((attrs) => ({ type: 'rule_def', attrs })));
  const body = json.content[1]!.content;
  body.splice(1, 0, {
    type: 'paragraph',
    attrs: { id: 'pDerived0000009X' },
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
          value: INCOME_VALUE,
          ...income,
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
          value: TOTAL_VALUE,
        },
      },
    ],
  });
  const doc = schema.nodeFromJSON(json);
  doc.check();
  return doc;
}

/** The value a connection's projection shows for one field id. */
function seen(doc: Node, conn: (typeof USERS)[keyof typeof USERS], id: string): unknown {
  const hidden = hiddenSet(conn, doc, basePermissions(), NOW);
  const p = project(doc, hidden, projectionSchema());
  let found: unknown = undefined;
  p.doc.descendants((n) => {
    if (n.type.name === 'form_field' && n.attrs['id'] === id) found = n.attrs['value'];
    return found === undefined;
  });
  return found;
}

describe('a value the rules compute from a hidden value is hidden (FRW-089 criterion 1, rules)', () => {
  it('hides the derived field from a reader who cannot read the sensitive one', () => {
    const doc = docWith([SUM_RULE]);
    const hidden = hiddenSet(USERS.frank, doc, basePermissions(), NOW);
    expect(hidden.values.has(INCOME_ID)).toBe(true);
    expect(hidden.values.has(TOTAL_ID)).toBe(true);
    expect(seen(doc, USERS.frank, INCOME_ID)).toEqual(REDACTED);
    expect(seen(doc, USERS.frank, TOTAL_ID)).toEqual(REDACTED);
  });

  it('shows the derived field to the owner, who reads everything (control)', () => {
    const doc = docWith([SUM_RULE]);
    expect(seen(doc, USERS.alice, INCOME_ID)).toBe(INCOME_VALUE);
    expect(seen(doc, USERS.alice, TOTAL_ID)).toBe(TOTAL_VALUE);
  });

  it('shows a value that no rule reads from a hidden value (control)', () => {
    const unrelated: JsonValue = {
      id: 'r_other',
      when: true,
      then: [{ set: { field: 'total', value: '9' } }],
    };
    const doc = docWith([unrelated]);
    expect(seen(doc, USERS.frank, TOTAL_ID)).toBe(TOTAL_VALUE);
  });

  it('shows the derived value when the document has no rules (control)', () => {
    const doc = docWith([]);
    expect(seen(doc, USERS.frank, TOTAL_ID)).toBe(TOTAL_VALUE);
    expect(seen(doc, USERS.frank, INCOME_ID)).toEqual(REDACTED);
  });

  it('hides every value when the rules cannot be read (fails closed)', () => {
    const broken: JsonValue = {
      id: 'r_broken',
      when: true,
      then: [{ set: { field: 'no_such_key', value: '1' } }],
    };
    const doc = docWith([broken]);
    expect(seen(doc, USERS.frank, TOTAL_ID)).toEqual(REDACTED);
  });
});
