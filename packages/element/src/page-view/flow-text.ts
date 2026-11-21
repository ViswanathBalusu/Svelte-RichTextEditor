/**
 * The text of the page view's lines (02 §9.1, §9.3; FE-101). The layout tree carries no text and no
 * fonts, so the painter asks this index: for a block and a range of CDM offsets, the runs of that
 * range, each in the face the layout measured it in, and the width of the range. Both come from the
 * flow the layout was made from, so the painted text is the measured text.
 *
 * Tabs are painted as tab characters with the document's default tab stop (`tab-size`); a tab stop
 * the paragraph sets, a leader and a numbering label's hanging tab are laid out by the engine but
 * are not painted exactly yet (recorded in FE-101 Notes).
 */
import type { PaintRun } from '../../../painter/src/painter.ts';
import {
  flowParagraphs,
  type FlowDocument,
  type FlowFont,
  type FlowParagraph,
} from '../../../layout/src/flow.ts';
import type { TextMeasurer } from '../../../layout/src/measure.ts';

/** The CSS font list of a face: the alias first and the browser's own serif after it, as canvas measures it. */
export function cssFamily(alias: string): string {
  return `"${alias.replace(/["\\]/g, '')}", serif`;
}

function runOf(font: FlowFont, text: string): PaintRun {
  return {
    text,
    fontFamily: cssFamily(font.family),
    fontSizePt: font.sizePt,
    bold: font.bold,
    italic: font.italic,
    underline: font.underline,
    strike: font.strike,
    color: font.color,
    // A raised or lowered run is set smaller by the layout's font; the CSS keyword only shifts it.
    vertAlign: font.vertAlign,
  };
}

/** The runs of paragraphs by block identifier, over a flow document. */
export class FlowText {
  readonly #byBlock = new Map<string, FlowParagraph[]>();
  readonly #measurer: TextMeasurer;
  readonly defaultTabPt: number;

  constructor(flow: FlowDocument, measurer: TextMeasurer) {
    this.#measurer = measurer;
    this.defaultTabPt = flow.defaultTabStop;
    const add = (p: FlowParagraph): void => {
      const list = this.#byBlock.get(p.id);
      if (list) list.push(p);
      else this.#byBlock.set(p.id, [p]);
    };
    for (const section of flow.sections) for (const p of flowParagraphs(section.blocks)) add(p);
    for (const blocks of flow.stories.values()) for (const p of flowParagraphs(blocks)) add(p);
    for (const note of flow.notes.values()) for (const p of note.blocks) add(p);
  }

  /** The paragraphs the flow made of a block (one, unless a break split it). */
  paragraphs(blockId: string): readonly FlowParagraph[] {
    return this.#byBlock.get(blockId) ?? [];
  }

  /** Whether the block is justified: its first flow paragraph says so. */
  justified(blockId: string): boolean {
    return this.#byBlock.get(blockId)?.[0]?.align === 'justify';
  }

  /** The runs of `[from, to)` of a block, in document order; null for a block the flow does not have. */
  runs(blockId: string, from: number, to: number): PaintRun[] | null {
    const paragraphs = this.#byBlock.get(blockId);
    if (!paragraphs) return null;
    const out: PaintRun[] = [];
    for (const p of paragraphs) {
      if (p.end < from || p.start > to) continue;
      for (const inline of p.inlines) {
        const a = inline.offset;
        const b = a + inline.size;
        if (inline.kind === 'text') {
          if (inline.role === 'label') {
            // A numbering label belongs to the first line of its paragraph.
            if (a === from) out.push(runOf(inline.font, inline.text));
          } else if (inline.role === 'text') {
            const s = Math.max(from, a);
            const e = Math.min(to, b);
            if (e > s) out.push(runOf(inline.font, inline.text.slice(s - a, e - a)));
          } else if (a >= from && b <= to) {
            // A field, an equation or a note mark never breaks: it is on the line that holds it.
            out.push(runOf(inline.font, inline.text));
          }
        } else if (inline.kind === 'tab') {
          if (a >= from && (b <= to || b === a)) out.push(runOf(inline.font, '\t'));
        }
      }
    }
    return out;
  }

  /** The width of `[from, to)` of a block in points, from the measurer the layout used. */
  width(blockId: string, from: number, to: number): number {
    const runs = this.runs(blockId, from, to);
    if (!runs) return 0;
    let sum = 0;
    for (const run of runs) {
      if (run.text === '\t') continue;
      sum += this.#measurer.advance(
        {
          family: unquoted(run.fontFamily),
          sizePt: run.fontSizePt,
          bold: run.bold,
          italic: run.italic,
        },
        run.text,
      );
    }
    return sum;
  }
}

/** The alias inside a `cssFamily` list. */
function unquoted(css: string): string {
  const m = /^"(.*)", serif$/.exec(css);
  return m?.[1] ?? css;
}
