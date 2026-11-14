/**
 * A layout pass that watches its fonts (02 §6, §9.3; FE-064 criterion 2). The pass measures through
 * the measurer of the current font epoch; as it measures, it notes each alias with the font source,
 * so the source knows which faces were not loaded when the widths were taken. After the pass it
 * tracks those aliases: when one of them loads, by any route, the epoch advances once, the caches
 * keyed by the old epoch no longer hit, and `fonts` resolves `true` so the caller lays out again.
 *
 * Universal: no DOM and no Node.js API (FND-004). The font source is injected (`faceArrivals` over
 * the page's `document.fonts` in the browser).
 */
import { layoutFlow, type LayoutFlowOptions, type LayoutResult } from './engine.ts';
import type { FaceArrivals } from './font-arrivals.ts';
import { FontEpoch } from './font-epoch.ts';
import { flowParagraphs, type FlowBlock, type FlowDocument } from './flow.ts';
import type { ItemProviders } from './items.ts';
import type { FontKey, TextMeasurer } from './measure.ts';

/**
 * `inner` with every measurement noted with `arrivals`, once per alias (`aliases` collects them).
 * The widths and the id are the inner measurer's.
 */
export function notingMeasurer(
  inner: TextMeasurer,
  arrivals: Pick<FaceArrivals, 'note'>,
  aliases: Set<string>,
): TextMeasurer {
  const note = (font: FontKey): void => {
    if (aliases.has(font.family)) return;
    aliases.add(font.family);
    arrivals.note(font.family);
  };
  const innerAdvances = inner.advances?.bind(inner);
  return {
    id: inner.id,
    advance(font, text) {
      note(font);
      return inner.advance(font, text);
    },
    ...(innerAdvances
      ? {
          advances(font: FontKey, text: string) {
            note(font);
            return innerAdvances(font, text);
          },
        }
      : {}),
    lineMetrics(font) {
      note(font);
      return inner.lineMetrics(font);
    },
  };
}

/**
 * The font aliases a layout pass over `doc` measures with (FE-064 criterion 1). `toFlow` resolves
 * each run's font from the document's style definitions and direct formatting (03 §6), so the
 * aliases are the families of every paragraph mark and inline in the body, the header and footer
 * stories and the footnotes, in tables too. In first-seen order, each once.
 */
export function flowFontAliases(doc: FlowDocument): string[] {
  const aliases = new Set<string>();
  const visit = (blocks: readonly FlowBlock[]): void => {
    for (const paragraph of flowParagraphs(blocks)) {
      aliases.add(paragraph.markFont.family);
      for (const inline of paragraph.inlines) aliases.add(inline.font.family);
    }
  };
  for (const section of doc.sections) visit(section.blocks);
  for (const blocks of doc.stories.values()) visit(blocks);
  for (const note of doc.notes.values()) visit(note.blocks);
  return [...aliases];
}

export interface FontPassResult {
  readonly result: LayoutResult;
  /** The epoch the pass measured under. */
  readonly epoch: number;
  /** The aliases the pass measured. */
  readonly aliases: ReadonlySet<string>;
  /**
   * Settles when every alias of the pass has settled: `true` when one arrived (the epoch advanced
   * and the pass is stale), `false` when none did. A face that never loads leaves it pending.
   */
  readonly fonts: Promise<boolean>;
}

export interface FontAwareLayoutOptions {
  /** The measurer without a cache; this layout caches it per epoch. */
  readonly measurer: TextMeasurer;
  readonly arrivals: FaceArrivals;
  readonly epoch?: FontEpoch;
}

/** Layout passes over one measurer, one font source and one font epoch. */
export class FontAwareLayout {
  readonly #inner: TextMeasurer;
  readonly #arrivals: FaceArrivals;
  readonly #epoch: FontEpoch;
  #cached: { readonly epoch: number; readonly measurer: TextMeasurer } | null = null;

  constructor(options: FontAwareLayoutOptions) {
    this.#inner = options.measurer;
    this.#arrivals = options.arrivals;
    this.#epoch = options.epoch ?? new FontEpoch();
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
   * Waits for the faces of `aliases` before a pass measures with them (FE-064 criterion 1). Each
   * alias is noted as it stands now, so a face that is not loaded counts as an arrival when it
   * loads, and the wait ends once every alias has settled; the epoch has then advanced if a face
   * arrived, so a pass started after this measures the loaded face. The arrivals source decides
   * whether it starts the load (`faceArrivals(..., { load: true })`); a face that never loads keeps
   * this pending. Resolves `true` when the epoch advanced.
   */
  async ready(aliases: readonly string[]): Promise<boolean> {
    const epoch = this.#epoch.value;
    for (const alias of aliases) this.#arrivals.note(alias);
    await this.#epoch.track(this.#arrivals, [...aliases]);
    return this.#epoch.value !== epoch;
  }

  /** One layout pass (`layoutFlow`) with the measurer of the current epoch; see `FontPassResult`. */
  layout(
    doc: FlowDocument,
    providers: Omit<ItemProviders, 'measurer'>,
    options: LayoutFlowOptions = {},
  ): FontPassResult {
    const epoch = this.#epoch.value;
    const aliases = new Set<string>();
    const measurer = notingMeasurer(this.measurer(), this.#arrivals, aliases);
    const result = layoutFlow(doc, { ...providers, measurer }, options);
    const fonts = this.#epoch
      .track(this.#arrivals, [...aliases])
      .then(() => this.#epoch.value !== epoch);
    return { result, epoch, aliases, fonts };
  }

  /**
   * A layout pass that waits for its fonts before it measures (FE-064 criterion 1; 02 §6). It reads
   * the aliases the pass needs from `doc` (`flowFontAliases`), waits for their faces (`ready`), and
   * only then runs `layout`, so the pass measures the loaded faces under the epoch the wait left. A
   * face that fails to load counts as settled and the pass measures the fallback; a face that never
   * settles keeps the pass pending (the spec sets no time limit).
   */
  async layoutWhenReady(
    doc: FlowDocument,
    providers: Omit<ItemProviders, 'measurer'>,
    options: LayoutFlowOptions = {},
  ): Promise<FontPassResult> {
    await this.ready(flowFontAliases(doc));
    return this.layout(doc, providers, options);
  }
}
