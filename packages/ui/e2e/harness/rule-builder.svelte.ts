/**
 * The rule builder's test harness (FRW-024): mounts `RuleBuilderPanel` alone over a small model that
 * answers as the core does. `?readOnly=1` makes the panel read-only; `?full=1` makes the document
 * hold 500 rules, so the next one is refused. `?bad=1` refuses every save with the keys of the rule,
 * as the core refuses a key the document lacks or a cycle (I14). Every
 * save and delete is recorded in `window.harness`, so Playwright can see what would reach the core.
 */
import { mount } from 'svelte';
import RuleBuilderPanel from '../../src/components/RuleBuilderPanel.svelte';
import type { RuleChangeResult, RuleItem, RulePartsView } from '../../src/core-api.ts';
import { SOURCE_TABLE } from '../../src/i18n/source.ts';

const params = new URLSearchParams(location.search);
const KEYS = ['tenant.maritalStatus', 'tenant.spouseName', 'tenant.amount', 'lease.total'];
const FIELDS = KEYS.map((key) => ({ key, label: key.split('.')[1] ?? key }));

const SPOUSE: RulePartsView = {
  left: { field: 'tenant.maritalStatus' },
  operator: '==',
  right: { literal: 'married' },
  then: [
    { effect: 'show', keys: ['tenant.spouseName'] },
    { effect: 'require', keys: ['tenant.spouseName'] },
  ],
  otherwise: [{ effect: 'hide', keys: ['tenant.spouseName'] }],
};

let rules = $state.raw<RuleItem[]>([
  { id: 'r_spouse', parts: SPOUSE, json: '' },
  {
    id: 'r_other',
    parts: null,
    json: JSON.stringify({ id: 'r_other', when: { and: [true, true] }, then: [] }, null, 2),
  },
]);

const saves: unknown[] = [];
const removes: string[] = [];
const shown: string[] = [];
(window as unknown as { harness: unknown }).harness = { saves, removes, shown };

function t(key: string, values?: Readonly<Record<string, string | number>>): string {
  const raw = (SOURCE_TABLE as Readonly<Record<string, unknown>>)[key];
  if (typeof raw !== 'string') return key;
  return raw.replace(/\{(\w+)\}/g, (match, name: string) => String(values?.[name] ?? match));
}

const keysOf = (parts: RulePartsView): string[] => [
  ...('field' in parts.left ? [parts.left.field] : []),
  ...('field' in parts.right ? [parts.right.field] : []),
  ...parts.then.flatMap((e) => e.keys),
  ...(parts.otherwise ?? []).flatMap((e) => e.keys),
];

function render(): void {
  mount(RuleBuilderPanel, {
    target: host!,
    props: {
      get rules() {
        return rules;
      },
      fields: FIELDS,
      readOnly: params.get('readOnly') === '1',
      nextId: () => `rule_${rules.length + 1}`,
      t,
      onsave(input: { id: string; parts: RulePartsView; replace?: string }): RuleChangeResult {
        if (params.get('full') === '1' && input.replace === undefined)
          return {
            ok: false,
            reason: 'rule_limit',
            limit: 500,
            message: 'A document has at most 500 rules.',
          };
        const unknown =
          params.get('bad') === '1'
            ? [...new Set(keysOf(input.parts))]
            : keysOf(input.parts).filter((k) => !KEYS.includes(k));
        if (unknown.length > 0)
          return {
            ok: false,
            reason: 'invalid_rules',
            problems: [{ message: 'A rule names a field that cannot be used.', keys: unknown }],
          };
        saves.push(input);
        const item = { id: input.id, parts: input.parts, json: '' };
        rules =
          input.replace === undefined
            ? [...rules, item]
            : rules.map((r) => (r.id === input.replace ? item : r));
        return { ok: true };
      },
      onremove(id: string): RuleChangeResult {
        removes.push(id);
        rules = rules.filter((r) => r.id !== id);
        return { ok: true };
      },
      onshow: (key: string) => shown.push(key),
    },
  });
}

const host = document.getElementById('host');
if (!host) throw new Error('no #host');
render();
