/**
 * Page-break reconciliation with the typeset result (02 §9.7; FE-100, 09 §7 level L1). When it is
 * switched on for a tenant, the page view adopts the typesetter's page starts, and line starts at
 * line granularity, for blocks that have not been edited since the layout's `seq`. Everything else
 * stays with the editor's own layout. This module holds the policy. `paginate` (paginate.ts, option
 * `pins`) adopts the page starts it gives, measures each pinned page's overflow on its own layout
 * and applies `judgePins`. The line starts of `lines` are cut into the paragraph by the breaker
 * (`breakParagraphAt`, lines.ts; `layoutFlow` option `lines`), so an unedited paragraph starts a line
 * at each typeset start (FE-100 criterion 1).
 *
 * Three rules are coded here:
 * - which typeset starts may be adopted: those of blocks not edited since `seq`, and line starts
 *   only when both the request and the file are at line granularity;
 * - whether the content between two reported page starts fits the editor's page: a page may
 *   overflow by up to a tolerance, and beyond that the editor drops the pin and marks the page as
 *   estimated until the next compile;
 * - the tolerance itself has no value in the spec ("small", 02 §9.7 and Open questions), so it is
 *   a required argument with no default. The caller takes it from the tenant's setting.
 *
 * Universal: no DOM and no Node.js API (FND-004). Lengths are in points.
 */
import type { Granularity, LayoutJson } from './layout-json.ts';

export interface PagePin {
  /** The typeset page number, from 1. */
  readonly page: number;
  readonly blockId: string;
  readonly offset: number;
}

export interface LinePin {
  readonly blockId: string;
  readonly offset: number;
}

export interface AdoptablePins {
  /** The granularity in force: `line` only when the request and the file both say `line`. */
  readonly granularity: Granularity;
  /** Page starts that may be adopted, in page order. */
  readonly pages: readonly PagePin[];
  /** Line starts that may be adopted; empty at block granularity. */
  readonly lines: readonly LinePin[];
  /**
   * Pages whose start block was edited since `seq`, or whose start is inside a block at block
   * granularity: the editor keeps its own break there.
   */
  readonly keptOwnPages: readonly number[];
}

/**
 * The granularity the page view uses: the requested one, but never finer than the file reports.
 * The file may report less than the request, for example when a block could not be reported at line
 * level (EXP-057); then block starts are used.
 */
export function effectiveGranularity(requested: Granularity, reported: Granularity): Granularity {
  return requested === 'line' && reported === 'line' ? 'line' : 'block';
}

/**
 * The pins that may be adopted from a validated file (FE-100 criteria 1, 4). A page start is kept
 * only when its block has not been edited since `seq`; the editor's own layout is used for the
 * rest. Line starts follow the same rule, and only at line granularity.
 *
 * `edited` holds the identifiers of the blocks edited after the layout's `seq`. It is the caller's
 * to compute from the commit log.
 */
export function adoptablePins(
  layout: LayoutJson,
  edited: ReadonlySet<string>,
  requested: Granularity,
): AdoptablePins {
  const granularity = effectiveGranularity(requested, layout.granularity);
  const pages: PagePin[] = [];
  const keptOwnPages: number[] = [];
  for (const page of layout.pages) {
    // At block granularity only block-level starts (offset 0) are used (09 §7: block-level page starts
    // are the guaranteed minimum); a start inside a block is a line-level start, and the editor keeps
    // its own break there.
    if (edited.has(page.starts.blockId) || (granularity === 'block' && page.starts.offset !== 0)) {
      keptOwnPages.push(page.n);
      continue;
    }
    pages.push({ page: page.n, blockId: page.starts.blockId, offset: page.starts.offset });
  }
  const lines: LinePin[] = [];
  if (granularity === 'line')
    for (const [blockId, block] of Object.entries(layout.blocks)) {
      if (edited.has(blockId)) continue;
      for (const offset of block.lineStarts) lines.push({ blockId, offset });
    }
  return Object.freeze({ granularity, pages, lines, keptOwnPages });
}

export interface PinJudgement {
  readonly pin: PagePin;
  /** Points by which the content between this start and the next exceeds the editor's page; 0 when it fits. */
  readonly overflow: number;
  /**
   * `fits`: no overflow. `overflows`: over the page, within the tolerance, so the pin is kept and
   * the page may overflow slightly. `dropped`: beyond the tolerance, so the pin is removed.
   */
  readonly decision: 'fits' | 'overflows' | 'dropped';
  /** True when the page is estimated until the next compile (its pin was dropped). */
  readonly estimated: boolean;
}

/**
 * Applies the overflow rule to each page pin (FE-100 criteria 2, 3). `overflow[i]` is the measured
 * overflow of pin `i`'s content, as the caller computed it from the editor's layout. The length must
 * match the pins. A tolerance is required and must be finite and not negative.
 */
export function judgePins(
  pins: readonly PagePin[],
  overflow: readonly number[],
  tolerance: number,
): readonly PinJudgement[] {
  if (overflow.length !== pins.length)
    throw new RangeError(`overflow has ${overflow.length} entries for ${pins.length} pins`);
  if (!Number.isFinite(tolerance) || tolerance < 0)
    throw new RangeError(`tolerance must be a finite length of at least 0, got ${tolerance}`);
  return Object.freeze(
    pins.map((pin, i) => {
      const over = overflow[i] as number;
      if (!Number.isFinite(over) || over < 0)
        throw new RangeError(`overflow must be a finite length of at least 0, got ${over}`);
      if (over === 0)
        return Object.freeze({ pin, overflow: over, decision: 'fits', estimated: false });
      if (over <= tolerance)
        return Object.freeze({ pin, overflow: over, decision: 'overflows', estimated: false });
      return Object.freeze({ pin, overflow: over, decision: 'dropped', estimated: true });
    }),
  ) as readonly PinJudgement[];
}

/** The pins that survive judgement: those that fit or overflow within the tolerance. */
export function keptPins(judgements: readonly PinJudgement[]): readonly PagePin[] {
  return judgements.filter((j) => j.decision !== 'dropped').map((j) => j.pin);
}

/** The typeset page numbers that are estimated until the next compile (FE-100 criterion 3). */
export function estimatedPages(judgements: readonly PinJudgement[]): readonly number[] {
  return judgements.filter((j) => j.estimated).map((j) => j.pin.page);
}
