/**
 * Paragraph gaps (03 §7, "Paragraph spacing"; CDM-043). The gap between two paragraphs is the
 * larger of the first one's `spaceAfter` and the second one's `spaceBefore`. Contextual spacing is
 * per side (ADR 0032): when two neighbours have the same style, a paragraph whose
 * `contextualSpacing` is on drops its own space on the side facing the other, so the gap between
 * two paragraphs of one style that both have it is zero.
 *
 * Flows (ADR 0032): a region and a section break are transparent, so spacing runs across them as
 * if they were not there; a block that is not a paragraph (a table, a figure, a display equation,
 * a table of contents, an extension, preserved content, a hidden region) has no spacing of its
 * own; at the start and the end of a container (the body, a table cell, a story) the first
 * paragraph keeps its `spaceBefore` and the last keeps its `spaceAfter`. Whether a page or column
 * break drops the space at the top of the next page belongs to pagination (02 §9.4), not here.
 */
import { type ParagraphContext, resolveParagraph } from '../cascade/resolve.ts';
import {
  type CascadeError,
  type StyleTable,
  type TreeNode,
  attrsOf,
  eachChild,
  typeOf,
} from '../cascade/styles.ts';

/** What the gap rule reads of a paragraph, after the cascade. */
export interface GapSide {
  readonly styleId: string;
  readonly spaceBefore: number;
  readonly spaceAfter: number;
  readonly contextualSpacing: boolean;
}

/**
 * The gap between two vertically adjacent blocks, in twips. `above` or `below` is null for a block
 * that is not a paragraph and for the edge of a container.
 */
export function paragraphGap(above: GapSide | null, below: GapSide | null): number {
  const same = above !== null && below !== null && above.styleId === below.styleId;
  const after = above === null ? 0 : same && above.contextualSpacing ? 0 : above.spaceAfter;
  const before = below === null ? 0 : same && below.contextualSpacing ? 0 : below.spaceBefore;
  return Math.max(after, before);
}

export interface FlowGap {
  /** The block above, or null at the start of the container. */
  readonly above: string | null;
  /** The block below, or null at the end of the container. */
  readonly below: string | null;
  readonly gap: number;
}

export interface FlowGaps {
  readonly gaps: readonly FlowGap[];
  readonly problems: readonly CascadeError[];
}

interface FlowItem {
  readonly id: string | null;
  readonly side: GapSide | null;
}

/** The blocks of a container in flow order: regions flattened, section breaks left out. */
function flowItems(
  table: StyleTable,
  container: TreeNode,
  context: ParagraphContext,
  problems: CascadeError[],
): FlowItem[] {
  const items: FlowItem[] = [];
  const add = (node: TreeNode): void => {
    const type = typeOf(node);
    if (type === 'region') return eachChild(node, add);
    if (type === 'section_break') return;
    const id = attrsOf(node)['id'];
    let side: GapSide | null = null;
    if (type === 'paragraph') {
      const r = resolveParagraph(table, attrsOf(node), context);
      if (r.ok) {
        const p = r.value.properties;
        side = {
          styleId: r.value.styleId,
          spaceBefore: p.spaceBefore,
          spaceAfter: p.spaceAfter,
          contextualSpacing: p.contextualSpacing,
        };
      } else problems.push(r.error);
    }
    items.push({ id: typeof id === 'string' ? id : null, side });
  };
  eachChild(container, add);
  return items;
}

/**
 * The gaps of one container's flow, including the leading and the trailing one. For a table cell,
 * pass the table's style as `tableStyle`.
 */
export function flowGaps(
  table: StyleTable,
  container: TreeNode,
  context: ParagraphContext = {},
): FlowGaps {
  const problems: CascadeError[] = [];
  const items = flowItems(table, container, context, problems);
  const gaps: FlowGap[] = [];
  let prev: FlowItem | null = null;
  for (const item of items) {
    gaps.push({
      above: prev?.id ?? null,
      below: item.id,
      gap: paragraphGap(prev?.side ?? null, item.side),
    });
    prev = item;
  }
  if (prev) gaps.push({ above: prev.id, below: null, gap: paragraphGap(prev.side, null) });
  return { gaps, problems };
}
