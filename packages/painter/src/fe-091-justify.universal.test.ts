/**
 * FE-091, criteria 1 and 3: a justified paragraph is painted with its extra space as computed word
 * spacing, and the painted width of each justified line equals the computed width (the paragraph's
 * column) within half a pixel (the target). The measure is the real canvas measurer
 * (`canvasTextMeasurer`, packages/element/src/canvas-measure.ts), and the sample lines hold no
 * kerned pair (AV, To, Wa, Ty, Yo, Ye), where Chromium's CSS kerning differs from canvas `auto`
 * (FE-090 Notes). The last line of the paragraph is not justified and keeps its natural width.
 *
 * Runs in Chromium, Firefox and WebKit (`pnpm vitest run --project browser
 * packages/painter/src/fe-091-justify.universal.test.ts`). In Node.js there is no DOM and the suite
 * is skipped.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { canvasTextMeasurer } from '../../element/src/canvas-measure.ts';
import type { LayoutTree, ParagraphFragment } from '../../layout/src/tree.ts';
import { paintTree, type PaintSource } from './painter.ts';

const PX_PER_PT = 96 / 72;
const FAMILY = 'serif';
// The painted family is written as the measurer writes it (canvas-measure.ts); see fe-090-metrics.
const PAINT_FAMILY = `"${FAMILY}", serif`;
const SIZE_PT = 12;
const font = { family: FAMILY, sizePt: SIZE_PT, bold: false, italic: false };

/** Three lines of one paragraph; the first two are justified, the last is not. */
const LINES = [
  'the quick brown fox jumps over the lazy dog and then',
  'runs off into the grey hills where the old mill stands',
  'and nobody follows it there.',
];

const hasDom = typeof document !== 'undefined';

// The column is a twentieth wider than the longer of the two justified lines in the face this
// machine gives `serif`, so that each of them has room to spread whatever the face. A fixed 300 pt
// was narrower than the lines in DejaVu Serif, where nothing can be justified (hosted CI, Linux).
const naturalPt = (text: string): number => canvasTextMeasurer().advance(font, text);
const COLUMN_PT = hasDom
  ? Math.ceil(Math.max(naturalPt(LINES[0]!), naturalPt(LINES[1]!)) * 1.05)
  : 300;

describe.skipIf(!hasDom)(
  'justified lines are painted at the column width (FE-091, criteria 1 and 3)',
  () => {
    let host: HTMLElement | null = null;

    afterEach(() => {
      host?.remove();
      host = null;
    });

    it('applies the computed word spacing and paints each justified line at the column width', () => {
      const measurer = canvasTextMeasurer();
      const text = LINES.join('\n');
      let y = 0;
      // The CDM range of each line: its own offsets inside the block, so they are distinct.
      let offset = 0;
      const lines = LINES.map((t, i) => {
        const line = {
          from: offset,
          to: offset + t.length,
          x: 0,
          y: i * 14,
          width: COLUMN_PT,
          height: 14,
        };
        offset += t.length + 1;
        y += 14;
        return line;
      });
      const fragment: ParagraphFragment = {
        kind: 'paragraph',
        blockId: 'p',
        from: 0,
        to: text.length,
        x: 0,
        y: 0,
        width: COLUMN_PT,
        height: y,
        lines,
      };
      const tree: LayoutTree = {
        engine: 'test',
        measurer: 'canvas',
        pages: [
          {
            index: 0,
            section: 0,
            width: COLUMN_PT,
            height: 200,
            fragments: [fragment],
            header: [],
            footer: [],
            footnotes: [],
          },
        ],
      };
      const el = document.createElement('div');
      document.body.appendChild(el);
      host = el;
      // Each line is its own CDM range here, so the line index identifies its text.
      const source: PaintSource = {
        lineText: (_block, from, to) => {
          const idx = lines.findIndex((l) => l.from === from && l.to === to);
          return LINES[idx < 0 ? 0 : idx]!;
        },
        fontFamily: PAINT_FAMILY,
        fontSizePt: SIZE_PT,
        measure: (t) => measurer.advance(font, t),
      };
      const { pages } = paintTree(el, tree, source, { justify: () => true });
      const spans = [...pages[0]!.querySelectorAll<HTMLElement>('.de-text')];
      expect(spans.length).toBe(LINES.length);

      const targetPx = COLUMN_PT * PX_PER_PT;
      // Criterion 1: the justified lines carry a computed word spacing, the last line none.
      expect(spans[0]!.style.wordSpacing).not.toBe('');
      expect(spans[1]!.style.wordSpacing).not.toBe('');
      expect(spans[2]!.style.wordSpacing).toBe('');

      // Criterion 3: the painted width of each justified line is the column, within half a pixel.
      for (const i of [0, 1]) {
        const painted = spans[i]!.getBoundingClientRect().width;
        expect(
          Math.abs(painted - targetPx),
          `line ${i}: painted ${painted}px, column ${targetPx}px`,
        ).toBeLessThanOrEqual(0.5);
      }
      // The last line keeps its natural width: it is shorter than the column.
      expect(spans[2]!.getBoundingClientRect().width).toBeLessThan(targetPx - 1);
    });
  },
);
