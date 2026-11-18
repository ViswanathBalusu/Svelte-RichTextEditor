/**
 * What a cross-reference may point at (FE-134 criterion 2; 03 §4.4 `ref`): the list the
 * cross-reference dialog offers. A `ref` field prints the label of its target, so only a target
 * that has a label is listed:
 *
 * - `bookmark`: a bookmark whose block carries a label (a numbered paragraph, a caption, a footnote);
 * - `heading`: a numbered heading, through its paragraph (`node:`); an unnumbered heading has no
 *   label to print, so it is not offered;
 * - `numbered`: any other numbered paragraph;
 * - `caption`: a figure, a table caption or any other block that holds a `seq` field;
 * - `equation`: a numbered equation block that has a label (`eq:`).
 *
 * `label` is what the reference prints; `text` is what the person recognises the target by (the
 * heading or caption text, the bookmark name, the equation label). Nothing is stored.
 */
import { computeLabels, referenceText } from '@docedit/model';
import type { Node as PMNode } from 'prosemirror-model';
import { isReferenceTarget } from './captions-refs.ts';
import { tocContext, tocEntries, type TocContext } from './toc-entries.ts';

export type ReferenceTargetKind = 'bookmark' | 'heading' | 'numbered' | 'caption' | 'equation';

export interface ReferenceTarget {
  readonly kind: ReferenceTargetKind;
  /** The value of the field's `target`: `node:`, `bookmark:` or `eq:`. */
  readonly target: string;
  /** What a reference to it prints. */
  readonly label: string;
  /** How the target is recognised: its text or its name. */
  readonly text: string;
}

/** The caption sequences the document uses, in the order they first occur. */
function sequenceNames(ctx: TocContext): string[] {
  const names: string[] = [];
  for (const list of ctx.labels.sequences.values()) {
    for (const s of list) if (s.name !== null && !names.includes(s.name)) names.push(s.name);
  }
  return names;
}

/** The targets of `doc`, in the order: headings, numbered paragraphs, captions, equations, bookmarks. */
export function referenceTargets(doc: PMNode): ReferenceTarget[] {
  const ctx = tocContext(doc);
  const labels = computeLabels(doc);
  const out: ReferenceTarget[] = [];
  const seen = new Set<string>();
  const add = (kind: ReferenceTargetKind, target: string, text: string): void => {
    if (seen.has(target) || !isReferenceTarget(target)) return;
    const label = referenceText(labels, target);
    if (label === null) return;
    seen.add(target);
    out.push({ kind, target, label, text });
  };

  const tocType = doc.type.schema.nodes['toc'];
  if (tocType) {
    const headings = tocEntries(ctx, tocType.create({ id: 'targets', minLevel: 1, maxLevel: 9 }));
    for (const e of headings) add('heading', `node:${e.blockId}`, e.text);
  }
  for (const { node } of ctx.blocks) {
    if (node.type.name !== 'paragraph') continue;
    const id = String(node.attrs['id'] ?? '');
    const list = labels.lists.get(id);
    if (list?.kind === 'number') add('numbered', `node:${id}`, node.textContent.trim());
  }
  if (tocType) {
    for (const name of sequenceNames(ctx)) {
      const entries = tocEntries(ctx, tocType.create({ id: 'targets', of: name }));
      for (const e of entries) add('caption', `node:${e.blockId}`, e.text);
    }
  }
  for (const [label] of labels.equationLabels) add('equation', `eq:${label}`, label);
  for (const [name] of labels.bookmarks) add('bookmark', `bookmark:${name}`, name);
  return out;
}
