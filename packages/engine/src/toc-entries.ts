/**
 * The entries of a table of contents or a list of figures or tables (FE-136 criterion 3; 03 §4.3
 * `toc`, §7). A `toc` atom stores no entries, only the outline levels it includes (`minLevel`,
 * `maxLevel`) and what it lists (`of`: `headings`, or the name of a caption sequence). The entries
 * are generated from the body, so they follow the headings and captions as these change. Nothing
 * is written into the document.
 *
 * - `headings`: every paragraph in the body whose style (through its `basedOn` chain) has an
 *   `outlineLevel` from `minLevel` to `maxLevel`, in document order, as the model's cascade reads it
 *   (`outlineLevelOf`). Its text is preceded by its list label when it is numbered
 *   (`computeLabels`, CDM-042).
 * - a sequence name such as `Figure`: every paragraph or caption that holds a `seq` field of that
 *   name, with the field shown as its computed number, as the editor and the PDF both show it
 *   (FE-134). The level of such an entry is 1.
 *
 * Page numbers are not given: the web view does not show pages (02 §7). Footnotes inside a heading
 * are left out of its text. An entry with no text is left out.
 *
 * Reading taken here, not stated by the spec: stories, definitions and footnote paragraphs are not
 * searched; regions and tables are, as `computeLabels` counts through them.
 */
import { computeLabels, outlineLevelOf, styleTable } from '@docedit/model';
import type { Node as PMNode } from 'prosemirror-model';
import { fieldTexts, type StaleCache } from './captions-refs.ts';

export interface TocEntry {
  /** The outline level for a heading (1 to 9); 1 for a caption entry. */
  readonly level: number;
  /** The list label of a numbered heading; empty for any other entry. */
  readonly label: string;
  readonly text: string;
  /** The identifier of the paragraph or figure the entry stands for. */
  readonly blockId: string;
}

type Labels = ReturnType<typeof computeLabels>;

/** The text of a block as the entry shows it: the computed text of `seq` and `ref` fields, no footnotes. */
function blockText(block: PMNode, start: number, texts: ReadonlyMap<number, StaleCache>): string {
  let out = '';
  block.forEach((child, offset) => {
    const pos = start + offset;
    if (child.isText) out += child.text ?? '';
    else if (child.type.name === 'field') {
      const computed = texts.get(pos)?.text;
      const cached = child.attrs['cached'];
      out += computed ?? (typeof cached === 'string' ? cached : '');
    } else if (child.type.name === 'break' || child.type.name === 'tab') out += ' ';
  });
  return out.replace(/\s+/g, ' ').trim();
}

/** The blocks that can be entries (paragraphs and captions) with their positions, in document order. */
function blocks(
  node: PMNode,
  start: number,
  out: Array<{ node: PMNode; pos: number; holder: string | null }>,
  holder: string | null,
): void {
  node.forEach((child, offset) => {
    const pos = start + offset;
    const name = child.type.name;
    if (name === 'paragraph') out.push({ node: child, pos, holder: null });
    else if (name === 'caption') out.push({ node: child, pos, holder });
    else if (name === 'figure') blocks(child, pos + 1, out, String(child.attrs['id'] ?? ''));
    else if (!child.isLeaf && !child.isTextblock) blocks(child, pos + 1, out, holder);
  });
}

/** The `toc` nodes of the body with their positions. */
export function tocNodes(doc: PMNode): Array<{ node: PMNode; pos: number }> {
  const out: Array<{ node: PMNode; pos: number }> = [];
  doc.forEach((top, offset) => {
    if (top.type.name !== 'body') return;
    top.descendants((node, at) => {
      if (node.type.name === 'toc') out.push({ node, pos: offset + 1 + at });
      return !node.isTextblock && !node.isLeaf;
    });
  });
  return out;
}

/** What the document gives every `toc` node: the labels and field texts are computed once. */
export interface TocContext {
  readonly doc: PMNode;
  readonly labels: Labels;
  readonly texts: ReadonlyMap<number, StaleCache>;
  readonly styles: ReturnType<typeof styleTable>;
  readonly blocks: ReadonlyArray<{ node: PMNode; pos: number; holder: string | null }>;
}

export function tocContext(doc: PMNode): TocContext {
  const labels = computeLabels(doc);
  const list: Array<{ node: PMNode; pos: number; holder: string | null }> = [];
  doc.forEach((top, offset) => {
    if (top.type.name === 'body') blocks(top, offset + 1, list, null);
  });
  return {
    doc,
    labels,
    texts: new Map(fieldTexts(doc, labels).map((f) => [f.pos, f])),
    styles: styleTable(doc),
    blocks: list,
  };
}

/** The entries of one `toc` node. */
export function tocEntries(ctx: TocContext, toc: PMNode): TocEntry[] {
  const of = typeof toc.attrs['of'] === 'string' ? toc.attrs['of'] : 'headings';
  const out: TocEntry[] = [];
  if (of === 'headings') {
    const min = Number(toc.attrs['minLevel'] ?? 1);
    const max = Number(toc.attrs['maxLevel'] ?? 3);
    for (const { node, pos } of ctx.blocks) {
      if (node.type.name !== 'paragraph') continue;
      const level = outlineLevelOf(ctx.styles, node.attrs);
      if (level === null || level < min || level > max) continue;
      const text = blockText(node, pos + 1, ctx.texts);
      if (text === '') continue;
      const id = String(node.attrs['id'] ?? '');
      out.push({ level, label: ctx.labels.lists.get(id)?.text ?? '', text, blockId: id });
    }
    return out;
  }
  // A caption sequence: the blocks that hold a `seq` field of that name.
  for (const { node, pos, holder } of ctx.blocks) {
    let holds = false;
    node.forEach((child, offset) => {
      if (
        child.type.name === 'field' &&
        child.attrs['kind'] === 'seq' &&
        child.attrs['name'] === of &&
        ctx.texts.has(pos + 1 + offset)
      )
        holds = true;
    });
    if (!holds) continue;
    const text = blockText(node, pos + 1, ctx.texts);
    if (text === '') continue;
    const id = String(holder ?? node.attrs['id'] ?? '');
    out.push({ level: 1, label: '', text, blockId: id });
  }
  return out;
}
