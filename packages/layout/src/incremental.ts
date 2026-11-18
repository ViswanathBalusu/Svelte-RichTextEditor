/**
 * Incremental layout (02 §9.5; FE-088, criteria 1 and 4): a layout engine that keeps the line
 * breaking of each paragraph from one pass to the next, so that an edit re-measures only the
 * blocks it changes. The engine itself is `layoutFlow` (`engine.ts`), unchanged: this module wraps
 * the injected line breaker, so the page pass and the tree are the ones a from-scratch layout gives.
 *
 * A paragraph's line breaking is reused when the block is not marked dirty and its breaker input is
 * the same as before. The input is what the breaker reads: the block identifier, the runs of text
 * and their fonts, the widths and the indents. It has no CDM offset, so a block that only moves
 * because an earlier block grew keeps its lines. A block whose input changed is re-measured even
 * when no edit marked it dirty, so a missed mark cannot leave a stale tree.
 *
 * The tree each `update` returns shares the previous tree's objects wherever they are equal
 * (`shareSubtrees`, `tree-share.ts`; FE-078 criterion 4), so a painter can tell by identity which
 * pages, fragments, rows and lines did not change.
 *
 * `coalescedLayout` coalesces the edits of one animation frame into one pass (criterion 3), with
 * the frame request injected by the host.
 *
 * Not built here (FE-088 criteria 2, 5 and 6): pagination still runs over the whole document, so
 * it does not restart at the first affected page; the keystroke latency is not measured; a remote
 * commit is not wired to the dirty marks. The cache keeps one entry per block identifier, so a
 * story laid out for several page numbers re-measures on each change of its input.
 *
 * Universal: no DOM and no Node.js API (FND-004).
 */
import type { FlowDocument } from './flow.ts';
import { layoutFlow, type LayoutResult } from './engine.ts';
import type { ItemProviders } from './items.ts';
import type { BreakOpportunities, LineBreaker, ParagraphInput } from './lines.ts';
import type { TextMeasurer } from './measure.ts';
import { shareSubtrees } from './tree-share.ts';
import { freezeTree, type LayoutTree, type ParagraphFragment } from './tree.ts';

/** What the last `update` did: the blocks whose line breaking ran, and how many were reused. */
export interface IncrementalStats {
  /** Block identifiers measured by the line breaker, in call order. Each appears once per update. */
  readonly measured: readonly string[];
  /** Line-breaking calls answered from the cache. */
  readonly reused: number;
}

export interface IncrementalLayout {
  /**
   * Lays out `doc`. `dirty` names the blocks an edit has changed since the previous call; the
   * others are reused where their breaker input is unchanged.
   */
  update(doc: FlowDocument, dirty?: ReadonlySet<string>): LayoutResult;
  /** The statistics of the last call. */
  readonly lastStats: IncrementalStats;
}

interface CacheEntry {
  readonly key: string;
  readonly fragment: ParagraphFragment;
}

/**
 * An incremental layout over fixed providers. The measurer, the break opportunities and the line
 * breaker are the ones given here, for every call: the cache is valid only for them.
 */
export function incrementalLayout(providers: ItemProviders): IncrementalLayout {
  const cache = new Map<string, CacheEntry>();
  let pending = new Set<string>();
  let touched = new Set<string>();
  let measured: string[] = [];
  let reused = 0;
  let previousTree: LayoutTree | null = null;
  let stats: IncrementalStats = Object.freeze({ measured: Object.freeze([]), reused: 0 });

  const breaker: LineBreaker = {
    id: `incremental(${providers.lineBreaker.id})`,
    breakParagraph(
      input: ParagraphInput,
      measurer: TextMeasurer,
      breaks: BreakOpportunities,
    ): ParagraphFragment {
      const id = input.blockId;
      const key = JSON.stringify(input);
      touched.add(id);
      const hit = cache.get(id);
      if (hit && hit.key === key && !pending.has(id)) {
        reused++;
        return hit.fragment;
      }
      // The first call for a dirty block measures it; later calls in the same pass reuse it.
      pending.delete(id);
      const fragment = providers.lineBreaker.breakParagraph(input, measurer, breaks);
      measured.push(id);
      cache.set(id, { key, fragment });
      return fragment;
    },
  };

  return {
    update(doc, dirty = new Set<string>()) {
      pending = new Set(dirty);
      touched = new Set<string>();
      measured = [];
      reused = 0;
      const result = layoutFlow(doc, { ...providers, lineBreaker: breaker });
      // Entries of blocks that this document no longer has are dropped.
      for (const id of [...cache.keys()]) if (!touched.has(id)) cache.delete(id);
      stats = Object.freeze({ measured: Object.freeze([...measured]), reused });
      // The tree shares what did not change with the one this call returned before (FE-078).
      const tree = shareSubtrees(previousTree, result.tree);
      previousTree = tree;
      return tree === result.tree ? result : freezeTree({ ...result, tree });
    },
    get lastStats() {
      return stats;
    },
  };
}

/**
 * Runs a pending layout pass for the host's next animation frame. The host passes its frame
 * request (`requestAnimationFrame` in a browser; a queue in Node.js tests), so the engine has no
 * clock of its own (FND-004).
 */
export type FrameRequest = (run: () => void) => void;

export interface CoalescedLayout {
  /**
   * Records an edit: `doc` replaces the pending document and the `dirty` blocks join the pending
   * set. The first edit of a frame asks the host for one frame; later edits in that frame ride on
   * it, so the frame runs one layout pass for all of them.
   */
  edit(doc: FlowDocument, dirty?: Iterable<string>): void;
  /** The result of the last frame's pass, or `undefined` before the first frame has run. */
  readonly result: LayoutResult | undefined;
  /** The number of layout passes the frames have run. */
  readonly passes: number;
}

/**
 * Coalesces the edits of one animation frame into one incremental pass (FE-088, criterion 3). The
 * pass is the `IncrementalLayout.update` call of `layout`, with the dirty blocks of every edit in
 * the frame. Pure apart from the injected `requestFrame`.
 */
export function coalescedLayout(
  layout: IncrementalLayout,
  requestFrame: FrameRequest,
): CoalescedLayout {
  let pendingDoc: FlowDocument | null = null;
  let pendingDirty = new Set<string>();
  let scheduled = false;
  let result: LayoutResult | undefined;
  let passes = 0;

  const frame = (): void => {
    scheduled = false;
    const doc = pendingDoc;
    if (doc === null) return;
    const dirty = pendingDirty;
    pendingDoc = null;
    pendingDirty = new Set<string>();
    result = layout.update(doc, dirty);
    passes++;
  };

  return {
    edit(doc, dirty = []) {
      pendingDoc = doc;
      for (const id of dirty) pendingDirty.add(id);
      if (!scheduled) {
        scheduled = true;
        requestFrame(frame);
      }
    },
    get result() {
      return result;
    },
    get passes() {
      return passes;
    },
  };
}
