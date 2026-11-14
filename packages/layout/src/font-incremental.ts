/**
 * An incremental layout pass that re-measures only the blocks whose font arrived (FE-064
 * criterion 3; 02 §6, §9.3, §9.5). It joins the three parts that each do one step:
 * - the font epoch (`font-epoch.ts`), which advances when a face a pass measured with arrives and
 *   names the arrived aliases (`takeArrived`);
 * - `blocksUsingFonts` (`font-dirty.ts`), which turns those aliases into the blocks that use them;
 * - the incremental layout (`incremental.ts`), which keeps each paragraph's line breaking unless
 *   the block is dirty or its breaker input changed.
 *
 * A font arrival does not change a paragraph's breaker input, so without the dirty set the
 * incremental cache would keep the fallback widths. Each pass here takes the arrivals from the
 * epoch, marks the blocks that use them dirty, and measures through the measurer of the current
 * epoch (`FontEpoch.measurer`, one cache per epoch), so the dirty blocks take the arrived face's
 * widths and every other block keeps its lines from the earlier pass.
 *
 * The incremental layout takes fixed providers; here its measurer is a stable front that forwards
 * to the measurer of the current epoch, wrapped so that every alias measured is noted with the
 * font source (`notingMeasurer`). The layout tree names the measurer the pass really used.
 *
 * Pagination still runs over the whole document (FE-088 criterion 2), so "re-laid out" is the
 * paragraph's line breaking; the fragments of the other blocks are reused.
 *
 * Universal: no DOM and no Node.js API (FND-004).
 */
import type { LayoutResult } from './engine.ts';
import type { FaceArrivals } from './font-arrivals.ts';
import { blocksUsingFonts } from './font-dirty.ts';
import { FontEpoch } from './font-epoch.ts';
import { notingMeasurer } from './font-pass.ts';
import type { FlowDocument } from './flow.ts';
import { incrementalLayout, type IncrementalLayout, type IncrementalStats } from './incremental.ts';
import type { ItemProviders } from './items.ts';
import type { FontKey, TextMeasurer } from './measure.ts';

export interface IncrementalFontLayoutOptions {
  /** The measurer without a cache; this layout caches it per epoch. */
  readonly measurer: TextMeasurer;
  readonly arrivals: FaceArrivals;
  readonly breaks: ItemProviders['breaks'];
  readonly lineBreaker: ItemProviders['lineBreaker'];
  readonly epoch?: FontEpoch;
}

export interface IncrementalFontPassResult {
  readonly result: LayoutResult;
  /** The epoch the pass measured under. */
  readonly epoch: number;
  /** The aliases that had arrived since the previous pass, taken from the epoch. */
  readonly arrived: ReadonlySet<string>;
  /** The blocks the pass marked dirty: those that use an arrived alias, and those the caller named. */
  readonly dirty: ReadonlySet<string>;
  /** What the incremental layout did: the blocks it measured and how many it reused. */
  readonly stats: IncrementalStats;
  /** The aliases the pass measured. */
  readonly aliases: ReadonlySet<string>;
  /**
   * Settles when every alias the pass measured has settled: `true` when one arrived (the epoch
   * advanced and the next pass re-measures its blocks), `false` when none did.
   */
  readonly fonts: Promise<boolean>;
}

/**
 * A measurer with a fixed identity that forwards every call to `current()`. The incremental layout
 * holds one measurer for its life; this lets the measurer behind it change with the epoch.
 */
function forwardingMeasurer(current: () => TextMeasurer, offerAdvances: boolean): TextMeasurer {
  return {
    get id() {
      return current().id;
    },
    advance: (font, text) => current().advance(font, text),
    ...(offerAdvances
      ? {
          advances(font: FontKey, text: string) {
            const m = current();
            // The epoch measurers wrap one inner measurer and keep its `advances`, so it is there.
            if (!m.advances)
              throw new Error('forwardingMeasurer: the current measurer has no advances');
            return m.advances(font, text);
          },
        }
      : {}),
    lineMetrics: (font) => current().lineMetrics(font),
  };
}

/** Incremental layout passes over one measurer, one font source and one font epoch. */
export class IncrementalFontLayout {
  readonly #inner: TextMeasurer;
  readonly #arrivals: FaceArrivals;
  readonly #epoch: FontEpoch;
  readonly #layout: IncrementalLayout;
  #cached: { readonly epoch: number; readonly measurer: TextMeasurer } | null = null;
  // The measurer of the pass running now; set before each `update` and read through the front.
  #current: TextMeasurer;

  constructor(options: IncrementalFontLayoutOptions) {
    this.#inner = options.measurer;
    this.#arrivals = options.arrivals;
    this.#epoch = options.epoch ?? new FontEpoch();
    this.#current = this.measurer();
    this.#layout = incrementalLayout({
      measurer: forwardingMeasurer(() => this.#current, options.measurer.advances !== undefined),
      breaks: options.breaks,
      lineBreaker: options.lineBreaker,
    });
  }

  /** The font epoch. */
  get epoch(): FontEpoch {
    return this.#epoch;
  }

  /** The measurer of the current epoch: one cache per epoch, so an old epoch's entries never hit. */
  measurer(): TextMeasurer {
    const epoch = this.#epoch.value;
    if (this.#cached?.epoch !== epoch)
      this.#cached = { epoch, measurer: this.#epoch.measurer(this.#inner) };
    return this.#cached.measurer;
  }

  /**
   * One incremental pass over `doc`. It takes the aliases that arrived since the previous pass
   * from the epoch, marks dirty every block that uses one of them (`blocksUsingFonts`) together
   * with the blocks in `edited`, and lays out with the measurer of the current epoch. Blocks that
   * are not dirty and whose breaker input is unchanged keep their lines and are not measured.
   */
  layout(doc: FlowDocument, edited: Iterable<string> = []): IncrementalFontPassResult {
    const epoch = this.#epoch.value;
    const arrived = this.#epoch.takeArrived();
    const dirty = blocksUsingFonts(doc, arrived);
    for (const id of edited) dirty.add(id);
    const aliases = new Set<string>();
    this.#current = notingMeasurer(this.measurer(), this.#arrivals, aliases);
    const result = this.#layout.update(doc, dirty);
    const stats = this.#layout.lastStats;
    const fonts = this.#epoch
      .track(this.#arrivals, [...aliases])
      .then(() => this.#epoch.value !== epoch);
    return { result, epoch, arrived, dirty, stats, aliases, fonts };
  }
}
