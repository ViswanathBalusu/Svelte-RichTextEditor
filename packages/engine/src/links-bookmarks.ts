/**
 * Links and bookmarks (FE-133 criteria 1 to 3; 03 §4.4 `anchor`, §5 `link`, §8 I4, I9).
 *
 * - A link is the `link` mark. Its target is checked against the CDM's pattern (I9: http, https,
 *   mailto, or an in-document target `#name`) before the mark is added; a refusal says why.
 * - A bookmark is an `anchor` atom with a name, unique in the document. The name follows the CDM's
 *   bookmark pattern; the uniqueness check is case-sensitive, because the CDM states no case rule
 *   (recorded in the epic's notes as a proposed decision, not decided here).
 * - Following an in-document link to a bookmark moves the caret to that bookmark. Links to headings
 *   are not covered here (no heading target is defined by the CDM yet).
 */
import { LINK_HREF_PATTERN } from '@docedit/model/definition';
import type { Node } from 'prosemirror-model';
import { TextSelection, type EditorState, type Transaction } from 'prosemirror-state';

/** The bookmark name pattern of the CDM (cdm1.ts, `anchor.name`). */
export const BOOKMARK_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;

/** The longest link target the CDM allows (`link.href`). */
export const MAX_HREF_LENGTH = 2048;

const LINK_TARGET = new RegExp(LINK_HREF_PATTERN);
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;
/** The schemes I9 allows; an in-document target is `#name`, which has no scheme. */
const ALLOWED_SCHEMES: readonly string[] = ['http', 'https', 'mailto'];

export type LinkRefusal = 'scheme-not-allowed' | 'malformed' | 'no-selection' | 'read-only';
export type LinkResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: LinkRefusal };

export type BookmarkRefusal = 'bad-name' | 'duplicate' | 'not-a-caret' | 'not-here' | 'read-only';
export type BookmarkResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: BookmarkRefusal };

export interface WritableOptions {
  /** Whether the region guard lets the user change the text at a position (07 §7). */
  readonly writable: (pos: number) => boolean;
}

/** Why a link target is refused, or null when it is allowed (I9). */
export function linkRefusalOf(href: string): LinkRefusal | null {
  if (href.length > MAX_HREF_LENGTH) return 'malformed';
  if (LINK_TARGET.test(href)) return null;
  const scheme = SCHEME.exec(href);
  if (scheme && !ALLOWED_SCHEMES.includes(scheme[1]!.toLowerCase())) return 'scheme-not-allowed';
  return 'malformed';
}

/** Adds a `link` mark with `href` to the selected text. */
export function addLink(
  state: EditorState,
  href: string,
  options: WritableOptions & { readonly title?: string },
  dispatch?: (tr: Transaction) => void,
): LinkResult {
  const refusal = linkRefusalOf(href);
  if (refusal) return { ok: false, reason: refusal };
  const { from, to, empty } = state.selection;
  if (empty) return { ok: false, reason: 'no-selection' };
  if (!options.writable(from) || !options.writable(to)) return { ok: false, reason: 'read-only' };
  const mark = state.schema.marks['link'];
  if (!mark) return { ok: false, reason: 'malformed' };
  if (dispatch) {
    const attrs: Record<string, string> = { href };
    if (options.title !== undefined) attrs['title'] = options.title;
    dispatch(state.tr.addMark(from, to, mark.create(attrs)).scrollIntoView());
  }
  return { ok: true };
}

/** The positions of every `anchor` node of the document, by name (names are unique, so one each). */
export function bookmarkPositions(doc: Node): Map<string, number> {
  const found = new Map<string, number>();
  doc.descendants((node, pos) => {
    if (node.type.name === 'anchor' && typeof node.attrs['name'] === 'string') {
      if (!found.has(node.attrs['name'])) found.set(node.attrs['name'], pos);
    }
    return true;
  });
  return found;
}

/**
 * Inserts a bookmark named `name` at the caret. The new `anchor` has a null identifier, which the
 * identifier plugin fills in the same update (FE-031; I2), as `enterAtStart` does for paragraphs.
 */
export function insertBookmark(
  state: EditorState,
  name: string,
  options: WritableOptions,
  dispatch?: (tr: Transaction) => void,
): BookmarkResult {
  if (!BOOKMARK_NAME_PATTERN.test(name)) return { ok: false, reason: 'bad-name' };
  if (bookmarkPositions(state.doc).has(name)) return { ok: false, reason: 'duplicate' };
  const type = state.schema.nodes['anchor'];
  if (!type) return { ok: false, reason: 'not-here' };
  const sel = state.selection;
  if (!sel.empty) return { ok: false, reason: 'not-a-caret' };
  const $pos = sel.$from;
  if (!$pos.parent.inlineContent) return { ok: false, reason: 'not-here' };
  if (!$pos.parent.canReplaceWith($pos.index(), $pos.index(), type)) {
    return { ok: false, reason: 'not-here' };
  }
  if (!options.writable($pos.pos)) return { ok: false, reason: 'read-only' };
  if (dispatch) {
    dispatch(state.tr.insert($pos.pos, type.create({ id: null, name })).scrollIntoView());
  }
  return { ok: true };
}

export type FollowResult = 'moved' | 'no-target' | 'not-internal';

/**
 * Follows an in-document link (`#name`): moves the caret to the bookmark of that name. A link to a
 * web page is not followed here; it opens in a new browsing context (FE-067).
 */
export function followInternalLink(
  state: EditorState,
  href: string,
  dispatch?: (tr: Transaction) => void,
): FollowResult {
  if (!href.startsWith('#')) return 'not-internal';
  const pos = bookmarkPositions(state.doc).get(href.slice(1));
  if (pos === undefined) return 'no-target';
  if (dispatch) {
    const tr = state.tr.setSelection(TextSelection.create(state.doc, pos));
    dispatch(tr.scrollIntoView());
  }
  return 'moved';
}
