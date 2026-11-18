// FRW-047 criteria 2 and 3: the server-authored `rules` commit of a completion clears the value of
// a hidden field, which P7 alone would refuse (12 §5.3); nothing else gets that way through.
import { AttrStep, type Step } from 'prosemirror-transform';
import type { Node } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { completionWrites } from '../src/workflow/completion.ts';
import { posOf } from './fixtures.ts';
import { FIELDS, USERS, fieldsJson, schema, verdictOf } from './permission-fixtures.ts';

type J = Record<string, unknown>;

/** The fixture with `value` stored in the fields named by id and `rules` among the definitions. */
function docWith(values: Partial<Record<keyof typeof FIELDS, unknown>>, rules: J[] = []): Node {
  const json = structuredClone(fieldsJson()) as unknown as { content: Array<{ content: J[] }> };
  json.content[0]!.content.push(...rules.map((attrs) => ({ type: 'rule_def', attrs })));
  const walk = (n: J): void => {
    const attrs = n['attrs'] as J | undefined;
    if (n['type'] === 'form_field' && attrs)
      for (const [name, value] of Object.entries(values))
        if (attrs['id'] === FIELDS[name as keyof typeof FIELDS]) attrs['value'] = value;
    for (const c of (n['content'] as J[] | undefined) ?? []) walk(c);
  };
  for (const top of json.content) walk(top as unknown as J);
  const doc = schema.nodeFromJSON(json);
  doc.check();
  return doc;
}

const set =
  (id: string, value: unknown) =>
  (doc: Node): Step[] => [new AttrStep(posOf(doc, id), 'value', value)];
const rules = { serverAuthored: true, origin: 'rules', fieldEnabled: () => false };

describe('a rules commit clears the value of a hidden field (FRW-047, 12 §5.3)', () => {
  it('lets a server-authored rules commit clear a hidden field of the participant', () => {
    const doc = docWith({ tenantName: 'Ada' });
    expect(verdictOf(USERS.erin, doc, set(FIELDS.tenantName, null), { extra: rules }).ok).toBe(
      true,
    );
  });

  it('refuses the same clearing from a client, and under another origin', () => {
    const doc = docWith({ tenantName: 'Ada' });
    const hidden = { fieldEnabled: () => false };
    expect(verdictOf(USERS.erin, doc, set(FIELDS.tenantName, null), { extra: hidden }).ok).toBe(
      false,
    );
    expect(
      verdictOf(USERS.erin, doc, set(FIELDS.tenantName, null), {
        extra: { ...hidden, origin: 'rules' },
      }).ok,
    ).toBe(false);
    expect(
      verdictOf(USERS.erin, doc, set(FIELDS.tenantName, null), {
        extra: { ...hidden, serverAuthored: true, origin: 'prefill' },
      }).ok,
    ).toBe(false);
  });

  it('lets the rules commit clear a value and nothing else: no new value in a hidden field', () => {
    const doc = docWith({ tenantName: 'Ada' });
    expect(verdictOf(USERS.erin, doc, set(FIELDS.tenantName, 'Bob'), { extra: rules }).ok).toBe(
      false,
    );
  });
});

describe('what the completion commit writes (FRW-047, 12 §5.3)', () => {
  const hide = { id: 'rHideName', when: true, then: [{ hide: ['tenant.name'] }] };
  const sum = {
    id: 'rTotal',
    when: true,
    then: [{ set: { field: 'lease.total', value: { '*': [{ field: 'tenant.amount' }, '2'] } } }],
  };

  it('gives the formula result and the clearing of a hidden field that holds a value', () => {
    const doc = docWith({ tenantName: 'Ada', number: '3.50' }, [hide, sum]);
    const w = completionWrites(doc, ['role_tenant']);
    expect(w.ok).toBe(true);
    if (!w.ok) return;
    expect(w.writes.find((x) => x.key === 'tenant.name')).toEqual({
      key: 'tenant.name',
      value: null,
      reason: 'hidden',
    });
    expect(w.writes.find((x) => x.key === 'lease.total')).toMatchObject({ reason: 'formula' });
    expect(w.writes.find((x) => x.key === 'lease.total')!.value).toMatch(/^7(\.0+)?$/);
    expect(w.writes.some((x) => x.key === 'tenant.amount')).toBe(false);
  });

  it('writes nothing for a hidden field that is empty or a formula that already holds its result', () => {
    const empty = docWith({}, [hide]);
    expect(completionWrites(empty, ['role_tenant'])).toEqual({ ok: true, writes: [] });
    const settled = docWith({ number: '3.50' }, [sum]);
    const first = completionWrites(settled, ['role_tenant']);
    if (!first.ok) throw new Error('rules unavailable');
    const stored = first.writes.find((x) => x.key === 'lease.total')!.value;
    const again = completionWrites(docWith({ number: '3.50', formula: stored }, [sum]), [
      'role_tenant',
    ]);
    expect(again).toEqual({ ok: true, writes: [] });
  });

  it('fails closed when the rules cannot be evaluated', () => {
    const cyc = docWith({}, [sum]);
    expect(completionWrites(cyc, ['role_tenant'], null, 0)).toEqual({
      ok: false,
      code: 'rules_unavailable',
    });
  });
});
