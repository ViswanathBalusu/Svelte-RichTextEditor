/**
 * The flow of blocks in one container (the body, a table cell, a header or footer story) and the
 * gaps between them: the model's `paragraphGap` (03 §7; ADR 0032 §3). Regions and section breaks
 * are transparent, blocks that are not paragraphs have no spacing of their own, and the edges of a
 * container keep the first `spaceBefore` and the last `spaceAfter`. A gap at the top of a page
 * (the body's start, after an explicit page break) is kept; any other gap is dropped at a page
 * break, as TeX and Word both do (ADR 0046).
 */
import { paragraphGap, type GapSide } from '@docedit/model';
import { line, type Ctx, type J } from './context.ts';
import { dimen, lit, tex } from './emit.ts';

const t = lit;

export interface ListFrame {
  listId: string;
  level: number;
  /** The frame's left margin in twips from the text margin. */
  margin: number;
}

export interface Flow {
  /** The previous block, for the gap rule: null at the start and after a block that is not a paragraph. */
  prev: GapSide | null;
  /** The next gap starts a page (the body's start, an explicit break): it is not discarded. */
  pageTop: boolean;
  /** The previous paragraph keeps with the next one. */
  keepNext: boolean;
  lists: ListFrame[];
  readonly place: 'body' | 'cell' | 'story';
  readonly tableStyle: string | null;
  /** The container that owns the blocks for map.json: the table of a cell, the story of a header. */
  readonly owner: string | null;
}

export function newFlow(
  place: Flow['place'],
  tableStyle: string | null,
  owner: string | null,
): Flow {
  return {
    prev: null,
    pageTop: place === 'body',
    keepNext: false,
    lists: [],
    place,
    tableStyle,
    owner,
  };
}

export function closeLists(ctx: Ctx, flow: Flow, keep: (f: ListFrame) => boolean): void {
  while (flow.lists.length > 0 && !keep(flow.lists[flow.lists.length - 1]!)) {
    flow.lists.pop();
    line(ctx, t('\\end{DElist}'));
  }
}

/** Writes the gap before a block (`below` null for a block that is not a paragraph). */
export function gap(ctx: Ctx, flow: Flow, below: GapSide | null): void {
  const g = paragraphGap(flow.prev, below);
  if (flow.keepNext) line(ctx, t('\\DEkeep'));
  flow.keepNext = false;
  if (g > 0)
    line(
      ctx,
      flow.pageTop
        ? tex`\DEgapkeep{${dimen(g, { min: 0, max: 31680 })}}`
        : tex`\DEgap{${dimen(g, { min: 0, max: 31680 })}}`,
    );
  flow.pageTop = false;
}

/** The gap after the last block of a cell or a story: it counts in the container's height. */
export function endGap(ctx: Ctx, flow: Flow): void {
  closeLists(ctx, flow, () => false);
  const g = paragraphGap(flow.prev, null);
  if (g > 0 && flow.place !== 'body') line(ctx, tex`\DEgap{${dimen(g, { min: 0, max: 31680 })}}`);
}

/** Sets the blocks of a container; injected into the table and story writers. */
export type ContentWriter = (flow: Flow, nodes: readonly J[] | undefined) => void;
