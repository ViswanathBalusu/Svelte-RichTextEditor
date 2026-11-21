/**
 * The words that explain a rejected change (PRM-024 criteria 1 and 2; 07 §7, §9). A rejection
 * names the part of the document whose change was refused: a region by its title, or the body,
 * the definitions, the header or footer, or the whole document. When the client knows who changed
 * the permissions, the message names that person through the host's directory; otherwise it says
 * only that the permissions changed (the reason line, in the pane).
 *
 * A region the reader may not see has no title on this client, so the message names nothing for
 * it (ADR 0019).
 */
import type { RecoveredItem, RegionSummary } from '../core-api.ts';
import type { Translator } from '../i18n/strings.ts';
import type { NameOf } from './regions.ts';
import '../i18n/late/recoveredPane.ts';

/**
 * The part of the document a refused change was in, in words, or null when the scope names no part
 * the reader can see. Scopes are DEP scope identifiers: `body`, `doc`, `defs:*`, `story:*`,
 * `region:<id>`.
 */
export function refusedPart(
  scope: string | null | undefined,
  regions: readonly RegionSummary[],
  tr: Translator,
): string | null {
  if (!scope) return null;
  if (scope === 'body') return tr.t('recovered.part.body');
  if (scope === 'doc') return tr.t('recovered.part.document');
  // DEP names the definitions as one `defs` scope (05 §5.3); the authority as `defs:*`.
  if (scope === 'defs' || scope.startsWith('defs:')) return tr.t('recovered.part.definitions');
  if (scope.startsWith('story:')) return tr.t('recovered.part.headerFooter');
  const m = /^region:(.+)$/.exec(scope);
  if (!m) return null;
  const title = regions.find((r) => r.id === m[1])?.title;
  return title ? tr.t('recovered.region', { title }) : null;
}

/**
 * Every part a refused change was in, in words, once each and in the rejection's order: the item's
 * `scopes`, or its `scope` when it has none. A part the reader cannot see is left out.
 */
export function refusedParts(
  item: Pick<RecoveredItem, 'scope' | 'scopes'>,
  regions: readonly RegionSummary[],
  tr: Translator,
): string[] {
  const out: string[] = [];
  for (const scope of item.scopes ?? [item.scope]) {
    const part = refusedPart(scope, regions, tr);
    if (part !== null && !out.includes(part)) out.push(part);
  }
  return out;
}

/**
 * The line that says who changed the permissions, and when if that is known, named through
 * `nameOf`; null when the changer is unknown, so the reason line alone says that the permissions
 * changed (PRM-024 criterion 2).
 */
export function changedByLine(
  item: Pick<RecoveredItem, 'changedBy' | 'changedAt'>,
  tr: Translator,
  nameOf: NameOf,
): string | null {
  if (!item.changedBy) return null;
  const name = nameOf(item.changedBy);
  const at = item.changedAt ? new Date(item.changedAt) : null;
  if (!at || Number.isNaN(at.getTime())) return tr.t('recovered.changedBy', { name });
  const when = tr.date(at, { dateStyle: 'medium', timeStyle: 'short' });
  return tr.t('recovered.changedByAt', { name, when });
}
