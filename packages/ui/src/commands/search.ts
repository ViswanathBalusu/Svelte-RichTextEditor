/**
 * Command search (13 §2, §4; UX-011). Pure functions over the registry: a query is matched
 * against the translated label of every offered command, and against its synonyms when the host
 * supplies them. Matching commands are listed with their state, so a command the user's access
 * does not allow is listed with its reason and cannot be run from the results (UX-004).
 *
 * Decisions the spec leaves open (see the story's Notes):
 * - Ranking: a label that starts with the whole query first, then a label that contains it, then
 *   a label that holds every word, then a match on a synonym only. Within a rank, registration
 *   order is kept.
 * - Synonyms come from the locale table (proposed, docs/adr/0383-w3-UX-011-command-synonyms.md):
 *   the key `synonyms.<command id>` holds the words, separated by semicolons.
 *   `synonymsFromStrings` reads them; `SynonymSource` stays injectable.
 */
import type { CommandRegistry } from './registry.ts';
import type { CommandView, ExecResult } from './types.ts';

/** The part of the translator the search needs: a label key to its text. */
export interface SearchTranslator {
  text(key: string): string;
}

/** The synonyms of a command in the current locale; empty when there are none. */
export type SynonymSource = (view: CommandView) => readonly string[];

/** The part of the translator that tells whether a key is in the current locale's table. */
export interface SynonymTranslator extends SearchTranslator {
  has(key: string): boolean;
}

/**
 * The synonyms of a command from the locale table: the words under `synonyms.<command id>`,
 * separated by semicolons. A locale without the key gives none, so a command is then found by its
 * label only.
 */
export function synonymsFromStrings(strings: SynonymTranslator): SynonymSource {
  return (view) => {
    const key = `synonyms.${view.id}`;
    if (!strings.has(key)) return [];
    return strings
      .text(key)
      .split(';')
      .map((word) => word.trim())
      .filter((word) => word !== '');
  };
}

export interface CommandSearchOptions {
  readonly translate: SearchTranslator;
  readonly synonyms?: SynonymSource;
  /** At most this many hits; the default is no limit. */
  readonly limit?: number;
}

export interface CommandSearchHit {
  readonly id: string;
  /** The translated label, as the results list shows it. */
  readonly label: string;
  /** The rank of the match: 0 is the best (see the module note). */
  readonly rank: 0 | 1 | 2 | 3;
  /** False when the user's access or the mode does not allow the command now. */
  readonly runnable: boolean;
  /** String key of the reason a command cannot run; null when it can. */
  readonly reasonKey: string | null;
}

export interface CommandSearchResults {
  /** The query as the user typed it, trimmed. */
  readonly query: string;
  readonly hits: readonly CommandSearchHit[];
  /**
   * `search.none` when the query has words and no command matches (the results show "No
   * results", UX-011 criterion 6); null otherwise.
   */
  readonly emptyKey: 'search.none' | null;
}

/** Lower case, canonical composition and single spaces; the form words are compared in. */
export function normaliseQuery(text: string): string {
  return text.normalize('NFC').toLowerCase().trim().split(/\s+/u).join(' ');
}

/**
 * Searches the offered commands of a registry. A command matches when every word of the query is
 * part of its label or one of its synonyms. An empty query lists nothing.
 */
export function searchCommands(
  registry: CommandRegistry,
  query: string,
  options: CommandSearchOptions,
): CommandSearchResults {
  const trimmed = query.trim();
  const normal = normaliseQuery(trimmed);
  const words = normal === '' ? [] : normal.split(' ');
  if (words.length === 0) return { query: trimmed, hits: [], emptyKey: null };
  const ranked: Array<CommandSearchHit & { order: number }> = [];
  registry.view.get().commands.forEach((view, order) => {
    if (!view.offered) return;
    const label = options.translate.text(view.entry.label);
    const labelForm = normaliseQuery(label);
    const synonyms = (options.synonyms?.(view) ?? []).map(normaliseQuery);
    const inLabel = words.every((w) => labelForm.includes(w));
    const inSynonyms = !inLabel && words.every((w) => synonyms.some((s) => s.includes(w)));
    if (!inLabel && !inSynonyms) return;
    const rank: 0 | 1 | 2 | 3 = labelForm.startsWith(normal)
      ? 0
      : labelForm.includes(normal)
        ? 1
        : inLabel
          ? 2
          : 3;
    ranked.push({
      id: view.id,
      label,
      rank,
      runnable: view.enabled,
      reasonKey: view.enabled ? null : view.reasonKey,
      order,
    });
  });
  ranked.sort((a, b) => a.rank - b.rank || a.order - b.order);
  const limited =
    options.limit === undefined ? ranked : ranked.slice(0, Math.max(0, options.limit));
  const hits: CommandSearchHit[] = limited.map(({ order: _order, ...hit }) => hit);
  return { query: trimmed, hits, emptyKey: hits.length === 0 ? 'search.none' : null };
}

/**
 * Runs a hit from the results. Nothing runs when the command cannot run now: `exec` refuses it
 * and says why, the same path as every surface (UX-004).
 */
export function runSearchHit(registry: CommandRegistry, hit: CommandSearchHit): ExecResult {
  return registry.exec(hit.id);
}

/**
 * What Enter does in the results: runs the first hit. With no hits nothing runs and the result is
 * null, so the caller shows the "no results" message instead (UX-011 criterion 6).
 */
export function activateFirstHit(
  registry: CommandRegistry,
  results: CommandSearchResults,
): ExecResult | null {
  const [first] = results.hits;
  if (!first) return null;
  return runSearchHit(registry, first);
}
