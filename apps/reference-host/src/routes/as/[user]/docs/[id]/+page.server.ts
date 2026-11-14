/**
 * The editor page (UX-093): the document's title from the host's catalogue, the endpoint the
 * element connects to, and, for the owner, the host's panels for region grants, roles and output
 * restrictions (UX-095 criterion 5; restrictions apply from the person's next token). Grants
 * change at once for everyone connected (07 §9); taking a role away revokes the person's sessions
 * on the document (05 §3.3; UX-092 criterion 4).
 */
import { error, fail } from '@sveltejs/kit';
import {
  OwnerOnlyError,
  RESTRICTION_NAMES,
  changeRole,
  renameDocument,
  setRegionGrant,
  setRestrictionsAs,
} from '../../../../../lib/server/documents.ts';
import { host } from '../../../../../lib/server/host.ts';
import { requirePerson } from '../../../../../lib/server/request.ts';
import { ServiceError } from '../../../../../lib/server/service.ts';
import type { DocRole } from '@docedit/protocol';
import {
  groupRows,
  parseRoleChoice,
  roleEffect,
  roleSavedMessage,
  type GroupRow,
} from '../../../../../lib/share/share-model.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, parent }) => {
  const { person } = await parent();
  const h = await host();
  const entry = h.catalogue.get(params.id);
  const role = entry?.roles[person.sub];
  if (!entry || !role) error(404, 'This document is not shared with you.');
  let owner: {
    regions: Array<{ id: string; title: string; editors: string[] }>;
    people: Array<{ sub: string; name: string; role: DocRole | null; restrict: string[] }>;
    groups: GroupRow[];
    restrictions: readonly string[];
  } | null = null;
  if (role === 'owner') {
    const [regions, grants] = await Promise.all([
      h.service.listRegions(entry.id),
      h.service.getGrants(entry.id),
    ]);
    owner = {
      regions: regions.map((r) => ({
        id: r.id,
        title: r.title,
        editors: grants.grants.grants
          .filter((g) => g.region === r.id && g.role === 'editor')
          .map((g) => g.principal),
      })),
      people: h.directory.users.map((u) => ({
        sub: u.sub,
        name: u.name,
        role: entry.roles[u.sub] ?? null,
        restrict: [...(entry.restrict?.[u.sub] ?? [])],
      })),
      groups: groupRows(h.directory.groups, h.directory.users, (sub) => entry.roles[sub] ?? null),
      restrictions: RESTRICTION_NAMES,
    };
  }
  return {
    doc: { id: entry.id, title: entry.title, role },
    endpoint: h.config.endpoint,
    viewerUrl: h.config.viewerUrl,
    owner,
    names: Object.fromEntries(h.directory.users.map((u) => [u.sub, u.name])),
  };
};

function ownerOnly(sub: string, id: string, h: Awaited<ReturnType<typeof host>>) {
  if (h.catalogue.roleOf(id, sub) !== 'owner') return fail(403, { problem: 'Only the owner can do this.' });
  return null;
}

function refused(e: unknown) {
  if (e instanceof ServiceError) return fail(400, { problem: `The document service refused: ${e.code}.` });
  if (e instanceof RangeError) return fail(400, { problem: e.message });
  throw e;
}

export const actions: Actions = {
  /** Gives a person `editor` on a region, or takes it away (07 §1). */
  grant: async ({ request, cookies, params }) => {
    const h = await host();
    const person = requirePerson(h, cookies, params.user);
    const denied = ownerOnly(person.sub, params.id, h);
    if (denied) return denied;
    const form = await request.formData();
    const region = String(form.get('region') ?? '');
    const sub = String(form.get('sub') ?? '');
    const give = form.get('change') === 'give';
    if (!h.directory.user(sub)) return fail(400, { problem: 'Choose a person.' });
    try {
      await setRegionGrant(h, params.id, person.sub, {
        region,
        principal: `user:${sub}`,
        role: give ? 'editor' : null,
      });
    } catch (e) {
      return refused(e);
    }
    return { done: `${give ? 'Gave' : 'Took'} edit rights on the region ${give ? 'to' : 'from'} ${h.directory.user(sub)!.name}.` };
  },

  /** Changes a person's role on the document; none takes it away and revokes their sessions. */
  role: async ({ request, cookies, params }) => {
    const h = await host();
    const person = requirePerson(h, cookies, params.user);
    const denied = ownerOnly(person.sub, params.id, h);
    if (denied) return denied;
    const form = await request.formData();
    const sub = String(form.get('sub') ?? '');
    const choice = parseRoleChoice(String(form.get('role') ?? ''));
    if (!h.directory.user(sub) || choice === undefined)
      return fail(400, { problem: 'Choose a person and a role.' });
    if (sub === person.sub) return fail(400, { problem: 'You cannot change your own role here.' });
    const role: DocRole | null = choice === 'none' ? null : choice;
    // A change of an existing role ends the person's sessions now (changeRole); a role given to
    // someone without one takes effect with their next token. The message says which (UX-095
    // criterion 2); the rule is in share-model.ts.
    const before = h.catalogue.roleOf(params.id, sub);
    try {
      await changeRole(h, params.id, sub, role);
    } catch (e) {
      return refused(e);
    }
    const name = h.directory.user(sub)!.name;
    return { done: roleSavedMessage(name, role, roleEffect(before, role)) };
  },

  /**
   * Sets a person's output restrictions (`no-export`, `no-copy`, `no-print`; UX-095 criterion 5).
   * They go into the person's next token as `restrict`; the check that the actor owns the document
   * is `setRestrictionsAs`'s, so it holds for every caller.
   */
  restrict: async ({ request, cookies, params }) => {
    const h = await host();
    const person = requirePerson(h, cookies, params.user);
    const form = await request.formData();
    const sub = String(form.get('sub') ?? '');
    if (!h.directory.user(sub)) return fail(400, { problem: 'Choose a person.' });
    const restrict = form.getAll('restrict').map(String);
    try {
      await setRestrictionsAs(h, person.sub, params.id, sub, restrict);
    } catch (e) {
      if (e instanceof OwnerOnlyError) return fail(403, { problem: e.message });
      return refused(e);
    }
    const name = h.directory.user(sub)!.name;
    return {
      done: `Saved the output restrictions of ${name}. They apply from ${name}'s next token.`,
    };
  },

  rename: async ({ request, cookies, params }) => {
    const h = await host();
    const person = requirePerson(h, cookies, params.user);
    const denied = ownerOnly(person.sub, params.id, h);
    if (denied) return denied;
    try {
      await renameDocument(h, params.id, String((await request.formData()).get('title') ?? ''), person.sub);
    } catch (e) {
      return refused(e);
    }
    return { done: 'Renamed.' };
  },
};
