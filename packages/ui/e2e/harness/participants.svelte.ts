/**
 * The participants list's test harness (FRW-026): mounts `ParticipantsPanel` alone over a small
 * model that answers as the element's service does. `?readOnly=1` makes the caller lack `manage`;
 * `?sent=1` makes the workflow sent; `?fail=stale` refuses every save as another writer's change.
 * `window.harness.hostWrites(list)` stands for a host that writes the workflow through the API: the
 * list changes with no action by the person at the page. Every save and removal is recorded in
 * `window.harness.saves` and `removes`, and every announcement in `announced`.
 */
import { mount } from 'svelte';
import ParticipantsPanel from '../../src/components/ParticipantsPanel.svelte';
import type {
  ParticipantChangeResult,
  ParticipantInput,
  ParticipantItem,
} from '../../src/core-api.ts';
import { SOURCE_TABLE } from '../../src/i18n/source.ts';

const params = new URLSearchParams(location.search);
const ROLES = [
  { id: 'role_tenant', name: 'Tenant' },
  { id: 'role_landlord', name: 'Landlord' },
];

let people = $state.raw<ParticipantItem[]>([
  {
    id: 'p1',
    name: 'Jane Doe',
    sub: 'u-jane',
    roles: ['role_tenant'],
    kind: 'signer',
    order: 1,
    state: null,
  },
]);
const sent = params.get('sent') === '1';

const saves: ParticipantInput[] = [];
const removes: string[] = [];
const announced: string[] = [];
(window as unknown as { harness: unknown }).harness = {
  saves,
  removes,
  announced,
  hostWrites(next: ParticipantItem[]): void {
    people = next;
  },
};

function t(key: string, values?: Readonly<Record<string, string | number>>): string {
  const raw = (SOURCE_TABLE as Readonly<Record<string, unknown>>)[key];
  if (typeof raw !== 'string') return key;
  return raw.replace(/\{(\w+)\}/g, (match, name: string) => String(values?.[name] ?? match));
}

function invalid(input: ParticipantInput): string[] {
  const bad: string[] = [];
  if (input.roles.length === 0) bad.push('roles');
  if (!Number.isSafeInteger(input.order) || input.order < 1) bad.push('order');
  if (input.name.trim() === '' && input.sub.trim() === '') bad.push('name');
  return bad;
}

const host = document.getElementById('host');
if (!host) throw new Error('no #host');
mount(ParticipantsPanel, {
  target: host,
  props: {
    get people() {
      return people;
    },
    roles: ROLES,
    canEdit: params.get('readOnly') !== '1' && !sent,
    workflowState: sent ? 'sent' : 'draft',
    t,
    async onsave(input: ParticipantInput): Promise<ParticipantChangeResult> {
      const bad = invalid(input);
      if (bad.length > 0) return { ok: false, reason: 'invalid', fields: bad };
      if (params.get('fail') === 'stale') return { ok: false, reason: 'stale' };
      saves.push(input);
      const item: ParticipantItem = {
        id: input.id ?? `p${people.length + 1}`,
        name: input.name.trim() || null,
        sub: input.sub.trim() || null,
        roles: input.roles,
        kind: input.kind,
        order: input.order,
        state: null,
      };
      people =
        input.id === undefined
          ? [...people, item]
          : people.map((p) => (p.id === input.id ? item : p));
      return { ok: true };
    },
    async onremove(id: string): Promise<ParticipantChangeResult> {
      removes.push(id);
      people = people.filter((p) => p.id !== id);
      return { ok: true };
    },
    announce: (key: string) => announced.push(key),
  },
});
