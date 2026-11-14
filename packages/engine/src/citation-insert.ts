/**
 * Inserting a citation at the caret (FE-140 criteria 1 and 4; CDM-052; 03 §4.4).
 *
 * - The sources come from the document's own `source_def` definitions (03 §4.1), so a citation
 *   can only name sources the document defines; an unknown source is refused, not created.
 * - Each item keeps the optional prefix, suffix, locator and locator label of the CDM (I4). Only the
 *   keys the author set are stored, so the node carries no empty members.
 * - The citation's text is generated at layout and export time (CDM-052), so this command stores
 *   sources and options only and never writes text.
 * - Where the region guard refuses the position, the command is unavailable (FE-140 criterion 4;
 *   07 §7): it returns `read-only` and changes nothing.
 *
 * The core runs it as the `insertCitation` command (core.ts), with the region guard's `canWrite` as
 * `writable`. The command registry entry and the keyboard binding are not part of this module
 * (UX-003 owns them).
 */
import type { LOCATOR_LABELS } from '@docedit/model/definition';
import type { Node } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';

/** The citation modes of the CDM (`citation.mode`): normal, narrative or without the authors. */
export const CITATION_MODES = ['normal', 'narrative', 'suppressAuthor'] as const;
export type CitationMode = (typeof CITATION_MODES)[number];

/** Items per citation: the CDM allows 1 to 32 (citations.ts). */
export const MAX_CITATION_ITEMS = 32;

export type LocatorLabel = (typeof LOCATOR_LABELS)[number];

/** One source in a citation, with the optional parts the author set. */
export interface CitationItemInput {
  readonly source: string;
  readonly prefix?: string;
  readonly suffix?: string;
  readonly locator?: string;
  readonly label?: LocatorLabel;
}

export type CitationRefusal =
  'no-items' | 'unknown-source' | 'not-a-caret' | 'not-here' | 'read-only';

export type CitationResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: CitationRefusal };

export interface InsertCitationOptions {
  /** The citation mode; `normal` when absent. */
  readonly mode?: CitationMode;
  /** Whether the region guard lets the user change the text at a position (07 §7). */
  readonly writable: (pos: number) => boolean;
}

/** The identifiers of the `source_def` nodes in the document's definitions. */
export function sourceIdsOf(doc: Node): Set<string> {
  const ids = new Set<string>();
  const defs = doc.firstChild;
  if (!defs) return ids;
  defs.forEach((child) => {
    if (child.type.name !== 'source_def') return;
    const id = child.attrs['id'];
    if (typeof id === 'string') ids.add(id);
  });
  return ids;
}

/** The CDM attributes of one item: only the keys the author set. */
function itemAttrs(item: CitationItemInput): Record<string, string> {
  const out: Record<string, string> = { source: item.source };
  if (item.prefix !== undefined) out['prefix'] = item.prefix;
  if (item.suffix !== undefined) out['suffix'] = item.suffix;
  if (item.locator !== undefined) out['locator'] = item.locator;
  if (item.label !== undefined) out['label'] = item.label;
  return out;
}

const fail = (reason: CitationRefusal): CitationResult => ({ ok: false, reason });

/**
 * Inserts a citation naming `items` at the caret. With `dispatch` absent, only checks whether the
 * insertion is possible (the `queryCommand` form).
 */
export function insertCitation(
  state: EditorState,
  items: readonly CitationItemInput[],
  options: InsertCitationOptions,
  dispatch?: (tr: Transaction) => void,
): CitationResult {
  if (items.length < 1 || items.length > MAX_CITATION_ITEMS) return fail('no-items');
  const known = sourceIdsOf(state.doc);
  for (const item of items) if (!known.has(item.source)) return fail('unknown-source');

  const type = state.schema.nodes['citation'];
  if (!type) return fail('not-here');
  const sel = state.selection;
  if (!sel.empty) return fail('not-a-caret');
  const $pos = sel.$from;
  if (!$pos.parent.inlineContent) return fail('not-here');
  if (!$pos.parent.canReplaceWith($pos.index(), $pos.index(), type)) return fail('not-here');
  if (!options.writable($pos.pos)) return fail('read-only');

  if (dispatch) {
    const node = type.create({
      items: items.map(itemAttrs),
      mode: options.mode ?? 'normal',
    });
    dispatch(state.tr.insert($pos.pos, node).scrollIntoView());
  }
  return { ok: true };
}
