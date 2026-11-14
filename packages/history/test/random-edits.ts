/**
 * Random edits for property tests: typing, deleting, splitting and joining paragraphs, pasting a
 * copy of another block, marks, attributes, re-typing a paragraph and wrapping blocks. Each makes a
 * transform on the document it is given, or null when it does not fit there.
 */
import type { Node } from 'prosemirror-model';
import { Fragment, Slice } from 'prosemirror-model';
import { AttrStep, ReplaceStep, Transform } from 'prosemirror-transform';
import { schema } from './fixtures.ts';

export type EditKind =
  'type' | 'delete' | 'split' | 'join' | 'paste' | 'mark' | 'attr' | 'retype' | 'field';

export const EDIT_KINDS: readonly EditKind[] = [
  'type',
  'type',
  'type',
  'delete',
  'split',
  'join',
  'paste',
  'mark',
  'attr',
  'retype',
  'field',
];

/** Textblocks with their positions, outside hidden content when `skip` names regions. */
export function textblocks(
  doc: Node,
  skip: ReadonlySet<string> = new Set(),
): Array<{ node: Node; pos: number }> {
  const out: Array<{ node: Node; pos: number }> = [];
  doc.descendants((n, pos) => {
    if (n.type.name === 'region' && skip.has(String(n.attrs['id']))) return false;
    if (n.type.name === 'footnote') return false;
    if (n.isTextblock) out.push({ node: n, pos });
    return !n.isTextblock;
  });
  return out;
}

let idn = 0;
const freshId = () => `pR${(++idn).toString(36).padStart(14, '0')}`;

/** One edit of a kind, at choices `a` and `b` in [0, 1). */
export function randomEdit(
  doc: Node,
  kind: EditKind,
  a: number,
  b: number,
  word: string,
  skip: ReadonlySet<string> = new Set(),
): Transform | null {
  const blocks = textblocks(doc, skip);
  if (!blocks.length) return null;
  const blk = blocks[Math.floor(a * blocks.length)]!;
  const start = blk.pos + 1;
  const size = blk.node.content.size;
  const at = start + Math.floor(b * (size + 1));
  const tr = new Transform(doc);
  try {
    switch (kind) {
      case 'type':
        return tr.insert(at, schema.text(word));
      case 'delete': {
        if (size === 0) return null;
        const from = start + Math.floor(b * size);
        const to = Math.min(start + size, from + 1 + Math.floor(a * 6));
        return tr.delete(from, to);
      }
      case 'split': {
        // A new paragraph gets an identifier of its own (03 §9).
        if (blk.node.type.name !== 'paragraph') return null;
        const $at = doc.resolve(at);
        if ($at.parent !== blk.node) return null;
        return tr.split(at, 1, [{ type: schema.nodes['paragraph']!, attrs: { id: freshId() } }]);
      }
      case 'join': {
        // Join this paragraph with the next one when they are siblings.
        const end = blk.pos + blk.node.nodeSize;
        const next = doc.nodeAt(end);
        if (!next || next.type.name !== 'paragraph' || blk.node.type.name !== 'paragraph')
          return null;
        if (doc.resolve(end).parent !== doc.resolve(blk.pos).parent) return null;
        return tr.join(end);
      }
      case 'paste': {
        // A copy of another textblock's text, pasted as text (a paragraph copy would repeat its id).
        const src = blocks[Math.floor(b * blocks.length)]!;
        const text = src.node.textContent.slice(0, 12);
        if (!text) return null;
        return tr.step(new ReplaceStep(at, at, new Slice(Fragment.from(schema.text(text)), 0, 0)));
      }
      case 'mark': {
        if (size === 0) return null;
        return tr.addMark(start, start + size, schema.marks['bold']!.create());
      }
      case 'attr':
        return tr.step(new AttrStep(blk.pos, 'align', b < 0.5 ? 'center' : 'end'));
      case 'retype': {
        if (blk.node.type.name !== 'paragraph') return null;
        return tr.setBlockType(blk.pos, blk.pos + blk.node.nodeSize, schema.nodes['paragraph']!, {
          ...blk.node.attrs,
          style: b < 0.5 ? 'LegalQuote' : null,
        });
      }
      case 'field': {
        let fieldPos = -1;
        doc.descendants((n, pos) => {
          if (n.type.name === 'region' && skip.has(String(n.attrs['id']))) return false;
          if (fieldPos < 0 && n.type.name === 'form_field') fieldPos = pos;
          return fieldPos < 0;
        });
        if (fieldPos < 0) return null;
        return tr.step(new AttrStep(fieldPos, 'value', word));
      }
    }
  } catch {
    return null;
  }
}
