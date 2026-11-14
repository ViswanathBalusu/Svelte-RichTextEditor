/**
 * Breaks and section breaks (FE-135 criteria 1, 2 and 6; 03 §4.2 `section_break`, §4.4 `break`, §10;
 * I10; 07 §5.2 P2).
 *
 * - A `break` is an inline atom of kind `line`, `page` or `column`. A page or column break is refused
 *   in a table cell, a caption and a footnote (I10); a line break is allowed everywhere inline.
 * - A `section_break` is a direct child of `body` only (CDM). It starts a new page section and takes
 *   its own `page_setup`, which is a definition in `defs`. The new definition is a copy of the page
 *   setup of the section the caret is in, without its header and footer stories (a story belongs to
 *   one page setup), under the identifier the caller gives.
 * - The caret must sit in body text outside every region. Structure changes need the P2 right
 *   (07 §5.2, PRM-011); this module checks only the position it is given (`writable`). The authority
 *   enforces P2 on commit, and no test here covers that right (FE-135 criterion 2 stays open).
 * - `sectionWarnings` reports a continuous section break whose margins differ from the section before
 *   it. The PDF reports such a break as unsupported (03 §10). Showing the warning is the view's
 *   (not built); this module only computes it.
 *
 * The core runs `insertBreak` and `insertSectionBreak` through its authoring commands (core.ts).
 */
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';

export const BREAK_KINDS = ['line', 'page', 'column'] as const;
export type BreakKind = (typeof BREAK_KINDS)[number];

export const SECTION_STARTS = ['nextPage', 'continuous', 'evenPage', 'oddPage'] as const;
export type SectionStart = (typeof SECTION_STARTS)[number];

/** The page setup margins a continuous break must keep, to be drawn on the same page (03 §10). */
const MARGIN_KEYS = ['marginTop', 'marginRight', 'marginBottom', 'marginLeft'] as const;

/** The page setup attributes that name header and footer stories (03 §4.1; header-footer.ts). */
const STORY_ATTRIBUTES = [
  'headerDefault',
  'headerFirst',
  'headerEven',
  'footerDefault',
  'footerFirst',
  'footerEven',
] as const;

export type BreakRefusal =
  'bad-kind' | 'not-here' | 'in-cell' | 'in-caption' | 'in-footnote' | 'read-only';

export type BreakResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: BreakRefusal };

export interface InsertBreakOptions {
  /** The region guard's `canWrite` for a position (07 §7). */
  readonly writable: (pos: number) => boolean;
}

const fail = <T extends string>(reason: T): { readonly ok: false; readonly reason: T } => ({
  ok: false,
  reason,
});

/** Whether `kind` is one of the CDM's break kinds. */
export function isBreakKind(kind: unknown): kind is BreakKind {
  return typeof kind === 'string' && (BREAK_KINDS as readonly string[]).includes(kind);
}

/**
 * Inserts a break of `kind` at the caret (replacing a selection). A page or column break inside a
 * table cell, a caption or a footnote is refused (I10); nothing changes then. Without `dispatch`
 * only the check runs (the `queryCommand` form).
 */
export function insertBreak(
  state: EditorState,
  kind: string,
  options: InsertBreakOptions,
  dispatch?: (tr: Transaction) => void,
): BreakResult {
  if (!isBreakKind(kind)) return fail('bad-kind');
  const type = state.schema.nodes['break'];
  const { $from } = state.selection;
  if (!type || !$from.parent.inlineContent) return fail('not-here');
  if (!$from.parent.canReplaceWith($from.index(), $from.index(), type)) return fail('not-here');
  if (kind !== 'line') {
    // Walk every ancestor, the root included: a footnote panel's document is the footnote itself.
    for (let d = $from.depth; d >= 0; d--) {
      const name = $from.node(d).type.name;
      if (name === 'table_cell') return fail('in-cell');
      if (name === 'caption') return fail('in-caption');
      if (name === 'footnote') return fail('in-footnote');
    }
  }
  if (!options.writable($from.pos)) return fail('read-only');
  if (dispatch) dispatch(state.tr.replaceSelectionWith(type.create({ kind })).scrollIntoView());
  return { ok: true };
}

export interface SectionBreakOptions {
  readonly start: string;
  /** The identifier of the new `section_break`; unique in the document. */
  readonly sectionId: string;
  /** The identifier of the new `page_setup` definition the section that follows takes. */
  readonly pageSetupId: string;
  readonly writable: (pos: number) => boolean;
}

export type SectionBreakRefusal =
  | 'bad-start'
  | 'not-a-caret'
  | 'not-here'
  | 'in-region'
  | 'not-in-body'
  | 'no-page-setup'
  | 'duplicate-id'
  | 'read-only';

export type SectionBreakResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: SectionBreakRefusal };

/** The `page_setup` definition with `id` in the document's `defs`, or null. */
export function pageSetupNode(doc: PMNode, id: string): PMNode | null {
  const defs = doc.firstChild;
  if (!defs || defs.type.name !== 'defs') return null;
  let found: PMNode | null = null;
  defs.forEach((child) => {
    if (found === null && child.type.name === 'page_setup' && child.attrs['id'] === id)
      found = child;
  });
  return found;
}

/** Whether any node in the document carries `id` as its identifier. */
function idInUse(doc: PMNode, id: string): boolean {
  let used = false;
  doc.descendants((node) => {
    if (node.attrs['id'] === id) used = true;
    return !used;
  });
  return used;
}

/**
 * The document position where a new `page_setup` goes in `defs`: after the last page setup. The
 * content of `defs` is `page_setup+ role_def* rule_def* source_def*`, so a page setup placed after a
 * source, rule or role definition does not fit; the end of `defs` is the fallback. `defs` is the
 * first child of the document, so its content starts at position 1.
 */
function pageSetupInsertPos(defs: PMNode): number {
  let at = -1;
  defs.forEach((child, offset) => {
    if (child.type.name === 'page_setup') at = 1 + offset + child.nodeSize;
  });
  return at >= 0 ? at : defs.nodeSize - 1;
}

/**
 * Inserts a section break at the caret, which must be in a paragraph that is a direct child of the
 * body (outside every region), and creates the page setup of the section that follows.
 */
export function insertSectionBreak(
  state: EditorState,
  options: SectionBreakOptions,
  dispatch?: (tr: Transaction) => void,
): SectionBreakResult {
  if (!(SECTION_STARTS as readonly string[]).includes(options.start)) return fail('bad-start');
  const { schema, doc } = state;
  const sectionType = schema.nodes['section_break'];
  const setupType = schema.nodes['page_setup'];
  if (!sectionType || !setupType) return fail('not-here');
  if (!state.selection.empty) return fail('not-a-caret');
  const { $from } = state.selection;

  // The caret's block must be a direct child of the body: depth 2 is a block of the body (depth 1).
  let inRegion = false;
  for (let d = $from.depth; d >= 1; d--) if ($from.node(d).type.name === 'region') inRegion = true;
  if (inRegion) return fail('in-region');
  if ($from.depth !== 2 || $from.node(1).type.name !== 'body' || !$from.parent.isTextblock) {
    return fail('not-in-body');
  }
  const body = $from.node(1);
  const blockIndex = $from.index(1);
  if (!body.canReplaceWith(blockIndex + 1, blockIndex + 1, sectionType)) return fail('not-here');

  // The page setup the caret's section uses: the last section break before it, else the body's.
  let sourceId: unknown = body.attrs['pageSetup'];
  for (let i = 0; i < blockIndex; i++) {
    const child = body.child(i);
    if (child.type.name === 'section_break') sourceId = child.attrs['pageSetup'];
  }
  const source = typeof sourceId === 'string' ? pageSetupNode(doc, sourceId) : null;
  if (!source) return fail('no-page-setup');
  if (pageSetupNode(doc, options.pageSetupId) !== null || idInUse(doc, options.sectionId)) {
    return fail('duplicate-id');
  }

  const after = $from.after(2);
  const defs = doc.firstChild!;
  const setupPos = pageSetupInsertPos(defs);
  if (!options.writable($from.pos) || !options.writable(setupPos)) return fail('read-only');

  if (dispatch) {
    const attrs: Record<string, unknown> = { ...source.attrs, id: options.pageSetupId };
    // A header or footer story belongs to one page setup: the copy starts without any (03 §4.1).
    for (const key of STORY_ATTRIBUTES) if (key in attrs) attrs[key] = null;
    const section = sectionType.create({
      id: options.sectionId,
      pageSetup: options.pageSetupId,
      start: options.start,
    });
    const tr = state.tr;
    // The later position first, so the earlier one is unchanged by the insertion.
    tr.insert(after, section);
    tr.insert(setupPos, setupType.create(attrs));
    dispatch(tr.scrollIntoView());
  }
  return { ok: true };
}

export interface SectionWarning {
  /** The identifier of the `section_break` that warns. */
  readonly sectionId: string;
  readonly reason: 'continuous-margin-change';
}

/**
 * Warnings about the body's section breaks (03 §10): a continuous break whose page setup changes a
 * margin from the section before it. The PDF reports such a break as unsupported.
 */
export function sectionWarnings(doc: PMNode): SectionWarning[] {
  const out: SectionWarning[] = [];
  doc.forEach((top) => {
    if (top.type.name !== 'body') return;
    let previous: unknown = top.attrs['pageSetup'];
    top.forEach((child) => {
      if (child.type.name !== 'section_break') return;
      const before = typeof previous === 'string' ? pageSetupNode(doc, previous) : null;
      const after = pageSetupNode(doc, String(child.attrs['pageSetup']));
      if (
        child.attrs['start'] === 'continuous' &&
        before !== null &&
        after !== null &&
        MARGIN_KEYS.some((k) => before.attrs[k] !== after.attrs[k])
      ) {
        out.push({ sectionId: String(child.attrs['id']), reason: 'continuous-margin-change' });
      }
      previous = child.attrs['pageSetup'];
    });
  });
  return out;
}
