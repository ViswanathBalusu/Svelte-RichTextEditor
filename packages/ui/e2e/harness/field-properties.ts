/**
 * The properties panel's test harness (FRW-073): mounts `FieldPropertiesPanel` alone, with a field
 * given by the URL. `?readOnly=1` makes the panel read-only; `?dupKey=1` gives the other fields the
 * key `tenant.name`, so that a key of that name is refused. Every commit is recorded in
 * `window.harness.commits`, so Playwright can see what would have reached the core.
 */
import { mount } from 'svelte';
import FieldPropertiesPanel from '../../src/components/FieldPropertiesPanel.svelte';
import { SOURCE_TABLE } from '../../src/i18n/source.ts';
import type { FieldDraft } from '../../src/shell/field-properties.ts';

const params = new URLSearchParams(location.search);

const ORIGINAL: FieldDraft = {
  key: 'tenant.amount',
  kind: 'number',
  label: 'Monthly rent',
  assignee: 'role_tenant',
  required: true,
  readOnly: false,
  default: null,
  placeholder: 'Amount',
  options: [],
  format: null,
  validation: { min: '0', max: '5000' },
  width: 120,
};

const commits: unknown[] = [];
const harness = { commits };
(window as unknown as { harness: typeof harness }).harness = harness;

/** The translator: the source table, with `{name}` replaced by the parameter. */
function t(key: string, values?: Readonly<Record<string, string | number>>): string {
  const raw = (SOURCE_TABLE as Readonly<Record<string, unknown>>)[key];
  if (typeof raw !== 'string') return key;
  return raw.replace(/\{(\w+)\}/g, (match, name: string) => String(values?.[name] ?? match));
}

const host = document.getElementById('host');
if (!host) throw new Error('no #host');
mount(FieldPropertiesPanel, {
  target: host,
  props: {
    original: ORIGINAL,
    context: {
      otherKeys: params.get('dupKey') === '1' ? ['tenant.name'] : ['tenant.name', 'lease.total'],
      roles: ['role_tenant', 'role_landlord'],
    },
    readOnly: params.get('readOnly') === '1',
    t,
    oncommit: (patch: unknown) => commits.push(patch),
  },
});
