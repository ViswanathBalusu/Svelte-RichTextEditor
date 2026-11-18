/**
 * Numbered captions and cross-references (FE-134 criteria 1, 2, 3 and 5; 03 §4.3, §4.4 `field`
 * kinds `seq` and `ref`; CDM-036, CDM-042).
 *
 * - A figure caption is a `caption` node in the figure, holding the text `Figure ` and a `seq`
 *   field named `Figure`. The number is the model's shared computation (`computeLabels`, CDM-042),
 *   run on the document with the caption in it, and stored in the field's `cached`.
 * - A `ref` field points at a target in the form the CDM gives (`node:`, `bookmark:` or `eq:`,
 *   cdm1.ts `FIELD_TARGET_PATTERN`). Its text is `referenceText` of the computed labels, stored as
 *   `cached`. A target with no label is refused, so the field is never inserted empty.
 * - `staleCaches` lists the `seq` and `ref` fields whose `cached` no longer matches the labels, after
 *   content moved or was inserted. `refreshCaches` builds the transaction that sets them. Nothing
 *   calls it on each change: owner decision 90 (2026-11-15) says a refreshed text is not written
 *   into the document but computed when shown (`fieldTexts`, drawn by
 *   view/computed-field-view.ts) and when exported.
 *
 * - A table has no caption node in the CDM, so a table caption is a paragraph just before the
 *   table, in the style `Caption` where the document defines it, holding the text `Table ` and a
 *   `seq` field named `Table` (the same reading as the list of tables of FE-136). A `node:` reference
 *   to that paragraph prints its number.
 * - An equation counts in the `Equation` sequence of the model (CDM-030) when it is `numbered`, not
 *   through a `seq` field, so an equation caption sets `numbered` on the block and gives it a
 *   `label` when it has none: only `eq:<label>` can refer to an equation.
 * - `referenceTargets` lists what a cross-reference dialog offers (FE-134 criterion 2).
 *
 * The deletion handling of I4 for a referenced target is `referenced-targets.ts`.
 */
import { FIELD_TARGET_PATTERN } from '@docedit/model/definition';
import { computeLabels, referenceText } from '@docedit/model';
import type { Node as PMNode } from 'prosemirror-model';
import { NodeSelection, type EditorState, type Transaction } from 'prosemirror-state';

/** The caption sequence a figure caption counts in (03 §4.3; CDM-042). */
export const FIGURE_SEQUENCE = 'Figure';

/** The `ref` targets this command inserts: a numbered block, a bookmark or an equation label. */
const REF_SCHEMES = ['node', 'bookmark', 'eq'] as const;
const TARGET = new RegExp(FIELD_TARGET_PATTERN);
/** A `field.format` as the CDM admits it (cdm1.ts `FIELD_FORMAT_PATTERN`). */
const FORMAT_PATTERN = /^[A-Za-z0-9 .,:;/()'-]{1,64}$/;

/** The caption sequence of a table caption paragraph (the CDM has no table caption node). */
export const TABLE_SEQUENCE = 'Table';

export type CaptionRefusal =
  | 'no-figure'
  | 'no-table'
  | 'no-equation'
  | 'has-caption'
  | 'not-here'
  | 'read-only'
  | 'no-number'
  | 'nothing-here';

export type CaptionResult =
  | {
      readonly ok: true;
      readonly number: string;
      /** The `ref` target that names what was numbered, when it has one. */
      readonly target?: string;
    }
  | { readonly ok: false; readonly reason: CaptionRefusal };

export type RefRefusal = 'bad-target' | 'no-target' | 'bad-format' | 'not-here' | 'read-only';

export type RefResult =
  | { readonly ok: true; readonly cached: string }
  | { readonly ok: false; readonly reason: RefRefusal };

const fail = <T extends string>(reason: T): { readonly ok: false; readonly reason: T } => ({
  ok: false,
  reason,
});

/** The position before the figure with identifier `id`, and the figure, or null. */
function figureById(doc: PMNode, id: string): { pos: number; node: PMNode } | null {
  let found: { pos: number; node: PMNode } | null = null;
  doc.descendants((node, pos) => {
    if (found === null && node.type.name === 'figure' && node.attrs['id'] === id) {
      found = { pos, node };
    }
    return found === null;
  });
  return found;
}

/**
 * Adds a numbered caption to the figure with identifier `figureId`, which has none. The caption
 * reads `Figure ` followed by its number. Refused when the figure is missing, already has a caption,
 * or the guard protects its position.
 */
export function insertCaption(
  state: EditorState,
  figureId: string,
  options: { readonly writable: (pos: number) => boolean },
  dispatch?: (tr: Transaction) => void,
): CaptionResult {
  const { schema, doc } = state;
  const found = figureById(doc, figureId);
  if (found === null) return fail('no-figure');
  if (found.node.childCount > 0) return fail('has-caption');
  const captionType = schema.nodes['caption'];
  const fieldType = schema.nodes['field'];
  if (!captionType || !fieldType || !found.node.type.contentMatch.matchType(captionType)) {
    return fail('not-here');
  }
  if (!options.writable(found.pos)) return fail('read-only');

  const caption = (cached: string | null): PMNode =>
    captionType.create(null, [
      schema.text('Figure '),
      fieldType.create({ kind: 'seq', name: FIGURE_SEQUENCE, cached }),
    ]);
  const start = found.pos + 1;

  // Number it on a copy with the caption in place, then store that number in the field.
  const probe = state.tr.insert(start, caption(null));
  const labels = computeLabels(probe.doc);
  const label = labels.sequences.get(figureId)?.find((s) => s.name === FIGURE_SEQUENCE);
  if (!label) return fail('no-number');

  if (dispatch) dispatch(state.tr.insert(start, caption(label.text)).scrollIntoView());
  return withTarget(label.text, `node:${figureId}`);
}

/** A success with the `ref` target when it is one the CDM admits. */
function withTarget(number: string, target: string): CaptionResult {
  return TARGET.test(target) ? { ok: true, number, target } : { ok: true, number };
}

/** Whether the document's definitions hold a style with this identifier. */
function definesStyle(doc: PMNode, id: string): boolean {
  let found = false;
  doc.descendants((node) => {
    if (node.type.name === 'style_def' && node.attrs['id'] === id) found = true;
    return !found && node.type.name !== 'body' && node.type.name !== 'story';
  });
  return found;
}

/**
 * The table at the caret: the outermost table whose parent is the body or a region, so a table in
 * a cell is captioned through the table that holds it. Null outside a table.
 */
function tableAtCaret(state: EditorState): { pos: number; node: PMNode } | null {
  const { $from } = state.selection;
  for (let d = 1; d <= $from.depth; d++) {
    const node = $from.node(d);
    const parent = $from.node(d - 1).type.name;
    if (node.type.name === 'table' && (parent === 'body' || parent === 'region')) {
      return { pos: $from.before(d), node };
    }
  }
  return null;
}

/** Whether the paragraph just before `pos` is a table caption already. */
function captionBefore(doc: PMNode, pos: number): boolean {
  const before = doc.resolve(pos).nodeBefore;
  if (before === null || before.type.name !== 'paragraph') return false;
  let holds = false;
  before.forEach((child) => {
    if (
      child.type.name === 'field' &&
      child.attrs['kind'] === 'seq' &&
      child.attrs['name'] === TABLE_SEQUENCE
    )
      holds = true;
  });
  return holds;
}

/**
 * Adds a numbered caption above the table at the caret: a paragraph `Table ` and a `seq` field
 * named `Table`, numbered by the model's computation. Refused outside a table, when the table has
 * a caption already, and where the guard protects the position. `id` is the new paragraph's.
 */
export function insertTableCaption(
  state: EditorState,
  options: { readonly writable: (pos: number) => boolean; readonly id: string },
  dispatch?: (tr: Transaction) => void,
): CaptionResult {
  const { schema, doc } = state;
  const paragraph = schema.nodes['paragraph'];
  const fieldType = schema.nodes['field'];
  const table = tableAtCaret(state);
  if (table === null) return fail('no-table');
  if (!paragraph || !fieldType) return fail('not-here');
  if (captionBefore(doc, table.pos)) return fail('has-caption');
  if (!options.writable(table.pos)) return fail('read-only');

  const style = definesStyle(doc, 'Caption') ? 'Caption' : null;
  const build = (cached: string | null): PMNode =>
    paragraph.create({ id: options.id, style }, [
      schema.text('Table '),
      fieldType.create({ kind: 'seq', name: TABLE_SEQUENCE, cached }),
    ]);
  const probe = state.tr.insert(table.pos, build(null));
  const label = computeLabels(probe.doc)
    .sequences.get(options.id)
    ?.find((s) => s.name === TABLE_SEQUENCE);
  if (!label) return fail('no-number');
  if (dispatch) dispatch(state.tr.insert(table.pos, build(label.text)).scrollIntoView());
  return withTarget(label.text, `node:${options.id}`);
}

/** The equation block with `id`, or the selected one when `id` is absent. */
function equationFor(
  state: EditorState,
  id: string | undefined,
): { pos: number; node: PMNode } | null {
  if (id === undefined) {
    const sel = state.selection;
    if (sel instanceof NodeSelection && sel.node.type.name === 'equation_block') {
      return { pos: sel.from, node: sel.node };
    }
    return null;
  }
  let found: { pos: number; node: PMNode } | null = null;
  state.doc.descendants((node, pos) => {
    if (found === null && node.type.name === 'equation_block' && node.attrs['id'] === id) {
      found = { pos, node };
    }
    return found === null;
  });
  return found;
}

/** The first `eq<n>` that no equation of the document uses as its label. */
function freshEquationLabel(doc: PMNode): string {
  const used = new Set<string>();
  doc.descendants((node) => {
    const label = node.type.name === 'equation_block' ? node.attrs['label'] : null;
    if (typeof label === 'string') used.add(label);
    return true;
  });
  let n = 1;
  while (used.has(`eq${n}`)) n++;
  return `eq${n}`;
}

/**
 * Numbers a block equation: sets `numbered`, so the model counts it in the `Equation` sequence, and
 * a `label` when it has none, so that a `ref` can name it as `eq:<label>`. The equation is the one
 * with `id`, or the selected one. Refused when it is numbered already.
 */
export function insertEquationCaption(
  state: EditorState,
  id: string | undefined,
  options: { readonly writable: (pos: number) => boolean },
  dispatch?: (tr: Transaction) => void,
): CaptionResult {
  const found = equationFor(state, id);
  if (found === null) return fail(id === undefined ? 'nothing-here' : 'no-equation');
  if (found.node.attrs['numbered'] === true) return fail('has-caption');
  if (!options.writable(found.pos)) return fail('read-only');
  const existing = found.node.attrs['label'];
  const label =
    typeof existing === 'string' && existing !== '' ? existing : freshEquationLabel(state.doc);
  const tr = state.tr
    .setNodeAttribute(found.pos, 'numbered', true)
    .setNodeAttribute(found.pos, 'label', label);
  const number = computeLabels(tr.doc).equations.get(String(found.node.attrs['id']));
  if (number === undefined) return fail('no-number');
  if (dispatch) dispatch(tr.scrollIntoView());
  return withTarget(number, `eq:${label}`);
}

/**
 * The caption command of the caret: a figure the selection is on or in, else the table the caret
 * is in, else the selected equation block. Refused where none of them is.
 */
export function insertCaptionHere(
  state: EditorState,
  options: { readonly writable: (pos: number) => boolean; readonly id: string },
  dispatch?: (tr: Transaction) => void,
): CaptionResult {
  const { $from } = state.selection;
  const sel = state.selection;
  if (sel instanceof NodeSelection && sel.node.type.name === 'equation_block') {
    return insertEquationCaption(state, undefined, options, dispatch);
  }
  for (let d = $from.depth; d >= 1; d--) {
    const node = $from.node(d);
    if (node.type.name === 'figure') {
      return insertCaption(state, String(node.attrs['id']), options, dispatch);
    }
  }
  if (sel instanceof NodeSelection && sel.node.type.name === 'figure') {
    return insertCaption(state, String(sel.node.attrs['id']), options, dispatch);
  }
  if (tableAtCaret(state) !== null) return insertTableCaption(state, options, dispatch);
  return fail('nothing-here');
}

/** Whether a target is one this command may insert a reference to (FE-134 criterion 2). */
export function isReferenceTarget(target: string): boolean {
  if (!TARGET.test(target)) return false;
  const colon = target.indexOf(':');
  return (REF_SCHEMES as readonly string[]).includes(target.slice(0, colon));
}

/**
 * Inserts a `ref` field to `target` at the caret, in `format` (or the default), with the text the
 * labels give it in `cached`. A target without a label is refused.
 */
export function insertReference(
  state: EditorState,
  target: string,
  format: string | null,
  options: { readonly writable: (pos: number) => boolean },
  dispatch?: (tr: Transaction) => void,
): RefResult {
  if (!isReferenceTarget(target)) return fail('bad-target');
  if (format !== null && !FORMAT_PATTERN.test(format)) return fail('bad-format');
  const type = state.schema.nodes['field'];
  const { $from } = state.selection;
  if (!type || !$from.parent.inlineContent) return fail('not-here');
  if (!$from.parent.canReplaceWith($from.index(), $from.index(), type)) return fail('not-here');
  const cached = referenceText(computeLabels(state.doc), target);
  if (cached === null) return fail('no-target');
  if (!options.writable($from.pos)) return fail('read-only');
  if (dispatch) {
    const node = type.create({ kind: 'ref', target, format, cached });
    dispatch(state.tr.replaceSelectionWith(node).scrollIntoView());
  }
  return { ok: true, cached };
}

export interface StaleCache {
  /** The position of the field node in the document. */
  readonly pos: number;
  readonly kind: 'seq' | 'ref';
  /** What the field holds now. */
  readonly cached: unknown;
  /** What the labels say it should hold; null for a `ref` whose target has no label. */
  readonly text: string | null;
}

/**
 * The `seq` and `ref` fields whose `cached` text differs from the computed labels, in document
 * order. A `seq` field counts through its holder's list of labels, as `computeLabels` writes them.
 */
export function staleCaches(doc: PMNode): StaleCache[] {
  return fieldTexts(doc).filter((f) => f.cached !== f.text);
}

/**
 * Every `seq` and `ref` field with the text the labels give it, in document order (FE-134
 * criterion 3). The web view shows this text, not `cached`, so that the numbers follow the content
 * as it moves; nothing is written into the document (decision 90 of
 * `docs/owner-decisions-2026-11-15.md`: refreshed texts are computed when shown and when exported).
 */
export function fieldTexts(
  doc: PMNode,
  labels: ReturnType<typeof computeLabels> = computeLabels(doc),
): StaleCache[] {
  const out: StaleCache[] = [];
  const counts = new Map<string, number>();

  const fieldAt = (child: PMNode, pos: number, holder: string | null): void => {
    const kind = child.attrs['kind'];
    if (kind === 'seq' && holder !== null) {
      const index = counts.get(holder) ?? 0;
      counts.set(holder, index + 1);
      const text = labels.sequences.get(holder)?.[index]?.text ?? '';
      out.push({ pos, kind, cached: child.attrs['cached'], text });
    } else if (kind === 'ref') {
      const target = child.attrs['target'];
      const text = typeof target === 'string' ? referenceText(labels, target) : null;
      out.push({ pos, kind, cached: child.attrs['cached'], text });
    }
  };

  // Walks the content of `node`, whose content starts at `start`; `holder` is the block that
  // holds the `seq` fields found directly in it.
  const visit = (node: PMNode, start: number, holder: string | null): void => {
    node.forEach((child, offset) => {
      const pos = start + offset;
      const name = child.type.name;
      if (name === 'paragraph') {
        visitInline(child, pos + 1, String(child.attrs['id']));
      } else if (name === 'caption') {
        visitInline(child, pos + 1, holder);
      } else if (name === 'figure') {
        visit(child, pos + 1, String(child.attrs['id']));
      } else if (!child.isLeaf) {
        visit(child, pos + 1, holder);
      }
    });
  };
  const visitInline = (block: PMNode, start: number, holder: string | null): void => {
    block.forEach((child, offset) => {
      const pos = start + offset;
      if (child.type.name === 'field') fieldAt(child, pos, holder);
      else if (!child.isLeaf) visit(child, pos + 1, holder);
    });
  };

  visit(doc, 0, null);
  return out;
}

/**
 * The transaction that sets every stale `cached` text to the computed one, or null when none is
 * stale. The caller decides when to dispatch it (see the module comment).
 */
export function refreshCaches(state: EditorState): Transaction | null {
  const stale = staleCaches(state.doc);
  if (stale.length === 0) return null;
  const tr = state.tr;
  for (const s of stale) tr.setNodeAttribute(s.pos, 'cached', s.text);
  return tr;
}
