/**
 * FE-090, criterion 2: when the container width changes, no painted line is re-wrapped by the
 * browser. Each line is an absolutely positioned box with `white-space: pre` and no set width
 * (painter.ts), so its width is shrink-to-fit inside its page box. A line could only be re-wrapped
 * when the width available to it, the page box's width less the line's left offset, drops below
 * the width of its text. The test makes that happen in two ways:
 *
 * - page 1 is narrower than every line's text from the start, so the lines overflow the page box;
 * - the host is narrowed and widened, and then every page box itself is squeezed to 120 pt and
 *   60 pt (as a host style or a narrow container could do), well below the text of every line.
 *
 * Before each step the test asserts that the available width really is below the text width, so
 * the case cannot pass by fitting. Each line must keep its offset in the page, its own box width,
 * its height, its painted text width and one client rect for its text (one row).
 *
 * A second test is the negative control: it applies `white-space: normal` to every painted line
 * and checks that the same comparison reports a change for every line, so the first test would
 * fail if the painter let the browser wrap.
 *
 * Runs in Chromium, Firefox and WebKit (`pnpm vitest run --project browser
 * packages/painter/src/fe-090-rewrap.universal.test.ts`). In Node.js there is no DOM and the suite
 * is skipped.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { LayoutPage, LayoutTree, ParagraphFragment } from '../../layout/src/tree.ts';
import { paintTree, type PaintSource } from './painter.ts';

const LINE_HEIGHT_PT = 14;
const WIDE_PAGE_PT = 500;
/** Narrower than every line's text: the lines on this page overflow their page box. */
const NARROW_PAGE_PT = 150;
/** Widths the page boxes are squeezed to; both are well below every line's text. */
const SQUEEZED_PAGE = ['120pt', '60pt'] as const;
const FAMILY = 'serif';
const SIZE_PT = 12;

/** Long single lines (each several hundred px wide at 12 pt), with runs of blanks inside. */
const LINES = [
  'The quick brown fox jumps over the lazy dog and keeps running well past the edge of the box',
  'Second line of the same kind, with ordinary spaces    and a run of   several blanks inside it',
  'Third line: office efficient final fi fl ffi ffl AVATAR Wave Yes, and it is also long enough',
];

function pageOf(index: number, width: number, texts: Record<string, string>): LayoutPage {
  const fragments: ParagraphFragment[] = LINES.map((text, i) => {
    const blockId = `p${index}-${i}`;
    texts[blockId] = text;
    return {
      kind: 'paragraph',
      blockId,
      from: 0,
      to: text.length,
      x: 0,
      y: i * 20,
      width,
      height: LINE_HEIGHT_PT,
      lines: [{ from: 0, to: text.length, x: 0, y: 0, width, height: LINE_HEIGHT_PT }],
    };
  });
  return {
    index,
    section: 0,
    width,
    height: 200,
    fragments,
    header: [],
    footer: [],
    footnotes: [],
  };
}

function treeFor(): { tree: LayoutTree; texts: Record<string, string> } {
  const texts: Record<string, string> = {};
  const pages = [pageOf(0, WIDE_PAGE_PT, texts), pageOf(1, NARROW_PAGE_PT, texts)];
  return { texts, tree: { engine: 'test', measurer: 'canvas', pages } };
}

interface Geometry {
  /** Offsets in the page box (the line's offset parent), which is centred and moves with the host. */
  readonly top: number;
  readonly left: number;
  /** The line box's own width: shrink-to-fit, so a wrapping browser would narrow it. */
  readonly boxWidth: number;
  readonly height: number;
  readonly textWidth: number;
  /** The number of client rects of the text: one per row the browser lays it out in. */
  readonly rows: number;
}

function geometry(lines: readonly HTMLElement[]): Geometry[] {
  return lines.map((line) => {
    const box = line.getBoundingClientRect();
    const span = line.querySelector<HTMLElement>('.de-text')!;
    const range = span.ownerDocument.createRange();
    range.selectNodeContents(span);
    return {
      top: line.offsetTop,
      left: line.offsetLeft,
      boxWidth: box.width,
      height: box.height,
      textWidth: span.getBoundingClientRect().width,
      rows: range.getClientRects().length,
    };
  });
}

/** The width the browser gives a line to lay its text in: the page box's content width less the line's left offset. */
function available(line: HTMLElement): number {
  return (line.offsetParent as HTMLElement).clientWidth - line.offsetLeft;
}

/** What differs between a line's geometry now and before; empty when the line is unchanged and one row. */
function changes(now: Geometry, before: Geometry): string[] {
  const out: string[] = [];
  for (const key of ['top', 'left', 'boxWidth', 'height', 'textWidth'] as const) {
    if (now[key] !== before[key]) out.push(`${key} ${before[key]} -> ${now[key]}`);
  }
  if (now.rows !== 1) out.push(`rows ${now.rows}`);
  return out;
}

function paint(): { host: HTMLElement; pages: readonly HTMLElement[]; lines: HTMLElement[] } {
  const { tree, texts } = treeFor();
  const host = document.createElement('div');
  host.style.width = '800px';
  document.body.appendChild(host);
  const source: PaintSource = {
    lineText: (block, from, to) => texts[block]!.slice(from, to),
    fontFamily: FAMILY,
    fontSizePt: SIZE_PT,
  };
  const { pages } = paintTree(host, tree, source);
  const lines = pages.flatMap((p) => [...p.querySelectorAll<HTMLElement>('.de-line')]);
  return { host, pages, lines };
}

describe.skipIf(typeof document === 'undefined')(
  'painted lines are not re-wrapped (FE-090, criterion 2)',
  () => {
    let host: HTMLElement | null = null;

    afterEach(() => {
      host?.remove();
      host = null;
    });

    it('keeps each line on one row when its available width drops below its text', () => {
      const painted = paint();
      host = painted.host;
      const { pages, lines } = painted;
      expect(lines.length).toBe(LINES.length * 2);

      const before = geometry(lines);
      const oneRowPx = (LINE_HEIGHT_PT * 96) / 72;
      for (const g of before) {
        expect(Math.abs(g.height - oneRowPx)).toBeLessThanOrEqual(0.5);
        expect(g.rows).toBe(1);
      }
      // Page 1 is narrower than the text of each of its lines from the start.
      lines.slice(LINES.length).forEach((line, i) => {
        expect(available(line), `page 1 line ${i}`).toBeLessThan(
          before[LINES.length + i]!.textWidth,
        );
      });

      const check = (step: string): void => {
        const now = geometry(lines);
        now.forEach((g, i) => {
          expect(changes(g, before[i]!), `line ${i} ${step}`).toEqual([]);
        });
      };

      for (const width of ['160px', '90px', '1200px']) {
        painted.host.style.width = width;
        check(`with the host at ${width}`);
      }

      painted.host.style.width = '90px';
      for (const width of SQUEEZED_PAGE) {
        for (const page of pages) page.style.width = width;
        // The squeeze is real: every line now has less room than its text.
        lines.forEach((line, i) => {
          expect(available(line), `line ${i} in a ${width} page`).toBeLessThan(
            before[i]!.textWidth,
          );
        });
        check(`in a ${width} page box`);
      }
    });

    it('detects a re-wrap: the same check fails for every line under white-space: normal', () => {
      const painted = paint();
      host = painted.host;
      const { pages, lines } = painted;
      const before = geometry(lines);

      for (const line of lines) line.style.whiteSpace = 'normal';
      // Page 1's lines are wider than their page box, so they wrap at once.
      const unsqueezed = geometry(lines);
      lines.slice(LINES.length).forEach((_, i) => {
        const k = LINES.length + i;
        expect(changes(unsqueezed[k]!, before[k]!), `page 1 line ${i}`).not.toEqual([]);
      });

      painted.host.style.width = '90px';
      for (const width of SQUEEZED_PAGE) {
        for (const page of pages) page.style.width = width;
        const now = geometry(lines);
        now.forEach((g, i) => {
          const found = changes(g, before[i]!);
          expect(found, `line ${i} in a ${width} page`).not.toEqual([]);
          // The text itself is laid out in more than one row.
          expect(g.rows, `line ${i} in a ${width} page`).toBeGreaterThan(1);
        });
      }
    });
  },
);
