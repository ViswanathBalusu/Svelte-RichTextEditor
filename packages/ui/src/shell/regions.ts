/**
 * Who can edit a region, in words (PRM-026; 07 §7; PRM-032 `RegionEditors`). The shell writes the
 * words, with names from the host's directory (UX-025), for three places: the lock indicator the
 * core draws on a region the user cannot edit (`CoreApi.setRegionLabels`), the announcement when
 * the caret enters such a region, and the permissions pane.
 *
 * Read restrictions (ADR 0019): a region the reader may not see arrives without a title and
 * without editors, and is described only as hidden; nothing names who can read or edit it.
 */
import type {
  AccessObject,
  AccessSummary,
  RegionLabel,
  RegionLabelDefaults,
  RegionSummary,
} from '../core-api.ts';
import type { StringKey } from '../i18n/en-GB.ts';
import type { Translator } from '../i18n/strings.ts';

/** A name for a principal (`user:<id>`, `group:<id>`): the host's, or a neutral word. */
export type NameOf = (principal: string) => string;

/** Joins names as the locale does ("A, B and C"). */
export function listOf(locale: string, items: readonly string[]): string {
  try {
    return new Intl.ListFormat(locale, { type: 'conjunction' }).format(items);
  } catch {
    return items.join(', ');
  }
}

/** The sentence that says who can edit a region. */
export function whoCanEdit(region: RegionSummary, tr: Translator, nameOf: NameOf): string {
  if (region.state === 'approved') return tr.t('region.editors.approved');
  const editors = region.editors;
  if (!editors)
    return region.title === null ? tr.t('reason.access.hidden') : tr.t('region.editors.none');
  if (editors.leasedTo)
    return tr.t('region.editors.lease', { name: nameOf(`user:${editors.leasedTo}`) });
  const names = editors.principals.map(nameOf);
  const roleKeys: StringKey[] = [];
  if (editors.roles.includes('editor')) roleKeys.push('region.role.editor');
  if (editors.roles.includes('owner')) roleKeys.push('region.role.owner');
  const roles = listOf(
    tr.locale,
    roleKeys.map((k) => tr.t(k)),
  );
  if (names.length && roleKeys.length)
    return tr.t('region.editors.namesAndRoles', { names: listOf(tr.locale, names), roles });
  if (names.length) return tr.t('region.editors.names', { names: listOf(tr.locale, names) });
  if (roleKeys.length) return tr.t('region.editors.roles', { roles });
  return tr.t('region.editors.none');
}

/** Whether the user may edit a region, from the DEP access (05 §5.5: every region is listed). */
export function mayEditRegion(access: AccessObject | null | undefined, id: string): boolean {
  const caps = access?.scopes[`region:${id}`];
  return caps !== undefined && caps.includes('edit');
}

/**
 * The short, visible words of a lock indicator: "Read-only", or "Suggestions only" where the user
 * may still suggest, since the region is then not read-only for them (07 §7, eighth bullet).
 */
export function regionIndicator(
  access: AccessObject | null | undefined,
  id: string,
  tr: Translator,
): string {
  const caps = access?.scopes[`region:${id}`];
  return tr.t(caps?.includes('suggest') ? 'region.indicator.suggest' : 'region.indicator');
}

/**
 * The words for the lock indicators of the regions the user cannot edit, by region identifier. A
 * region they can edit gets none, so the core draws no indicator there (PRM-026 criterion 1).
 */
export function regionLabels(
  regions: readonly RegionSummary[],
  access: AccessObject | null | undefined,
  tr: Translator,
  nameOf: NameOf,
): Record<string, RegionLabel> {
  const out: Record<string, RegionLabel> = {};
  for (const region of regions) {
    if (mayEditRegion(access, region.id)) continue;
    out[region.id] = {
      indicator: regionIndicator(access, region.id, tr),
      // An approved region says that an owner must change its state first (PRM-048 criterion 2).
      description:
        region.state === 'approved' ? tr.t('region.lock.approved') : whoCanEdit(region, tr, nameOf),
    };
  }
  return out;
}

/**
 * The words of a locked region the list above does not name (PRM-026). The core decides from the
 * access which regions are locked, so it may shade one the region list does not hold yet: a region
 * the access does not list (05 §5.5; PRM-006), which says that its permissions have not arrived,
 * or any region when the backend gives no region list, which says only that it is read-only.
 */
export function regionLabelDefaults(tr: Translator): RegionLabelDefaults {
  const indicator = tr.t('region.indicator');
  return {
    locked: { indicator, description: '' },
    unlisted: { indicator, description: tr.t('reason.access.unlisted') },
  };
}

/**
 * What to announce when the selection moves into another scope (PRM-026 criterion 5; UX-104
 * criterion 1): a read-only region and who can edit it, or hidden content in plain words. Null for
 * a scope the user may change, or when the scope did not change.
 */
export function scopeAnnouncement(
  previous: AccessSummary | undefined,
  next: AccessSummary | undefined,
  regions: readonly RegionSummary[],
  tr: Translator,
  nameOf: NameOf,
): string | null {
  if (!next || previous?.scope === next.scope) return null;
  if (next.limit === 'hidden') return tr.t('reason.access.hidden');
  if (next.caps.includes('edit') || next.caps.includes('suggest')) return null;
  const m = /^region:(.+)$/.exec(next.scope);
  if (!m) return null;
  const region = regions.find((r) => r.id === m[1]);
  const who = region ? whoCanEdit(region, tr, nameOf) : '';
  return region?.title
    ? tr.t('announce.region.readOnlyTitled', { title: region.title, who })
    : tr.t('announce.region.readOnly', { who }).trim();
}

/**
 * The role placeholders whose name contains `text`, as grant candidates (`role:<id>`; 07 §1, 12
 * §4.3; FRW-012 criterion 4). They come from the document's own role definitions, so the host's
 * directory is not asked for them. The pane lists them beside the users and groups it finds.
 */
export function roleCandidates(
  roles: readonly { readonly id: string; readonly name: string }[],
  text: string,
): Array<{ principal: string; name: string }> {
  const needle = text.trim().toLocaleLowerCase();
  if (needle === '') return [];
  return roles
    .filter((r) => r.name.toLocaleLowerCase().includes(needle))
    .map((r) => ({ principal: `role:${r.id}`, name: r.name }));
}

/**
 * The candidates the permissions pane offers for a grant (07 §1, §7): what the host's directory
 * found. On a `restricted` region it never offers `everyone`, even if the host's directory
 * returns it: grant validation refuses it (PRM-061; owner decision 12 of 2026-11-15).
 */
export function grantableCandidates<T extends { principal: unknown }>(
  found: readonly T[],
  policy: 'inherit' | 'restricted' | 'confidential' | undefined,
): Array<T & { principal: string }> {
  return found.filter(
    (p): p is T & { principal: string } =>
      typeof p?.principal === 'string' && !(policy === 'restricted' && p.principal === 'everyone'),
  );
}
