/**
 * Fixes for the issues of the accessibility checker, by block (UX-067 criterion 2; 13 section 8).
 * The checker names a block by its identifier and a kind of issue; the author gives the value (the
 * text, the level, the colour) and this command makes the change. Every position goes through the
 * scope guard, so a block the user may not change is refused and nothing moves.
 *
 * The fixes, one per kind of issue:
 * - `alt-text`: the alternative text of a figure, of the fallback picture of an extension block, or
 *   of the first picture of a paragraph that has none;
 * - `table-header`: the first row of a table becomes its header row;
 * - `link-text`: the text of the link stretch with the given index in a paragraph (the checker
 *   counts a stretch as the consecutive inline nodes under one `href`);
 * - `heading-level`: the paragraph takes the built-in style `Heading<level>`;
 * - `text-colour`: the text of the paragraph (the caption, for a figure) takes the colour.
 *
 * The text edits (link text and colour) are refused where suggestions are on, because they would
 * not be recorded as suggestions; the attribute edits follow `setImageAlt`, which does not record
 * them either.
 */
import type { Node as PmNode } from 'prosemirror-model';
import { Fragment } from 'prosemirror-model';
import type { Command } from 'prosemirror-state';
import type { BlockFix } from './block-fix-types.ts';
import { isParagraphStyle } from './styles.ts';

export type { BlockFix } from './block-fix-types.ts';

const COLOUR = /^#[0-9a-fA-F]{6}$/;

const isBlank = (value: unknown): boolean => typeof value !== 'string' || value.trim() === '';

/** The block with this identifier, outside the definitions, with its position. */
function findBlock(doc: PmNode, id: string): { node: PmNode; pos: number } | null {
  let found: { node: PmNode; pos: number } | null = null;
  doc.descendants((node, pos) => {
    if (found !== null || node.type.name === 'defs') return false;
    if (node.isBlock && node.attrs['id'] === id) found = { node, pos };
    return found === null;
  });
  return found;
}

/** The block that holds the text the checker read for this identifier: the caption of a figure. */
function textBlock(block: { node: PmNode; pos: number }): { node: PmNode; pos: number } | null {
  if (block.node.isTextblock) return block;
  if (block.node.type.name !== 'figure') return null;
  let caption: { node: PmNode; pos: number } | null = null;
  block.node.forEach((child, offset) => {
    if (caption === null && child.type.name === 'caption')
      caption = { node: child, pos: block.pos + 1 + offset };
  });
  return caption;
}

/** The inline children of a text block that make up the link stretch with this index. */
function linkStretch(
  block: PmNode,
  index: number,
): { from: number; to: number; nodes: PmNode[] } | null {
  const stretches: { from: number; to: number; nodes: PmNode[]; href: string }[] = [];
  let last: string | null = null;
  block.forEach((child, offset) => {
    const mark = child.marks.find((m) => m.type.name === 'link');
    const href = mark ? String(mark.attrs['href']) : null;
    if (href !== null && href !== last)
      stretches.push({ from: offset, to: offset, nodes: [], href });
    last = href;
    if (href === null) return;
    const stretch = stretches[stretches.length - 1]!;
    stretch.nodes.push(child);
    stretch.to = offset + child.nodeSize;
  });
  return stretches[index] ?? null;
}

/**
 * The command that makes `fix` on the block with this identifier. `writable` says whether a
 * position may be changed; `suggesting` whether suggestions are on there. False, with nothing
 * changed, when the block or the thing to fix is not there, the value is not allowed or the
 * position is read-only.
 */
export function blockFix(
  id: string,
  fix: BlockFix,
  writable: (pos: number) => boolean,
  suggesting: (pos: number) => boolean,
): Command {
  return (state, dispatch) => {
    const doc = state.doc;
    const block = findBlock(doc, id);
    if (block === null || !writable(block.pos)) return false;
    const { node, pos } = block;
    switch (fix.fix) {
      case 'alt-text': {
        const text = fix.text.trim();
        if (text === '') return false;
        if (node.type.name === 'figure') {
          if (!dispatch) return true;
          dispatch(state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, alt: text }));
          return true;
        }
        if (node.type.name === 'extension_block') {
          if (!dispatch) return true;
          dispatch(state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, fallbackText: text }));
          return true;
        }
        if (!node.isTextblock) return false;
        let at = -1;
        let image: PmNode | null = null;
        node.forEach((child, offset) => {
          if (image === null && child.type.name === 'image' && isBlank(child.attrs['alt'])) {
            image = child;
            at = pos + 1 + offset;
          }
        });
        if (image === null) return false;
        if (dispatch)
          dispatch(
            state.tr.setNodeMarkup(at, undefined, {
              ...(image as PmNode).attrs,
              alt: text,
            }),
          );
        return true;
      }
      case 'table-header': {
        if (node.type.name !== 'table' || node.childCount < 1) return false;
        if ((node.attrs['headerRows'] as number) >= 1) return false;
        if (dispatch)
          dispatch(state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, headerRows: 1 }));
        return true;
      }
      case 'heading-level': {
        if (!node.isTextblock || node.type.name !== 'paragraph') return false;
        if (!Number.isInteger(fix.level) || fix.level < 1 || fix.level > 9) return false;
        const style = `Heading${fix.level}`;
        if (!isParagraphStyle(doc, style)) return false;
        if (node.attrs['style'] === style) return false;
        if (dispatch) dispatch(state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, style }));
        return true;
      }
      case 'link-text': {
        const target = textBlock(block);
        const text = fix.text.trim();
        if (target === null || text === '' || suggesting(target.pos)) return false;
        const stretch = linkStretch(target.node, fix.index);
        if (stretch === null) return false;
        const texts = stretch.nodes.filter((n) => n.isText);
        const others = stretch.nodes.filter((n) => !n.isText && n.type.name !== 'image');
        if (others.length > 0) return false;
        const base = target.pos + 1;
        if (texts.length === 0) {
          // Only pictures: the link's text is their alternative text.
          const image = stretch.nodes.find((n) => isBlank(n.attrs['alt'])) ?? stretch.nodes[0]!;
          let offset = stretch.from;
          for (const n of stretch.nodes) {
            if (n === image) break;
            offset += n.nodeSize;
          }
          if (dispatch)
            dispatch(
              state.tr.setNodeMarkup(base + offset, undefined, { ...image.attrs, alt: text }),
            );
          return true;
        }
        const marks = texts[0]!.marks;
        if (dispatch)
          dispatch(
            state.tr.replaceWith(
              base + stretch.from,
              base + stretch.to,
              Fragment.from(state.schema.text(text, marks)),
            ),
          );
        return true;
      }
      case 'text-colour': {
        const target = textBlock(block);
        if (target === null || !COLOUR.test(fix.colour) || suggesting(target.pos)) return false;
        const type = state.schema.marks['color'];
        if (!type || target.node.content.size === 0) return false;
        if (dispatch) {
          const from = target.pos + 1;
          const to = from + target.node.content.size;
          dispatch(state.tr.addMark(from, to, type.create({ value: fix.colour.toUpperCase() })));
        }
        return true;
      }
    }
  };
}
