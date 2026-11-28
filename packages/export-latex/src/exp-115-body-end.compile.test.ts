/**
 * EXP-115 criterion 1, the end of the body: the `bottom` of the frames of the model's shared fixture
 * `header-growth.json` run against the LaTeX writer, read in the compiled PDF. (The start of the
 * body runs in `cdm-045-header-growth.test.ts`, the slots in `exp-115-header-slots.compile.test.ts`.)
 *
 * The layout report has no end of the body, so the end is found by filling the page. The body is
 * a column of one-line paragraphs of an exact line height `L` and no spacing; the number `n` of
 * them on page 1 (counted in the text of the page) satisfies `n * L <= height < (n + 1) * L` for the
 * height of the body, which the fixture gives as `bottom - top`. The test runs each frame with two
 * line heights, one chosen so that the fixture's height is a few twips above a whole number of lines
 * (a body that is short by more than those twips loses a line) and one a few twips below the next
 * whole number (a body that is longer by more than those twips gains one). Both counts must equal
 * the fixture's.
 *
 * Node.js only; needs `lualatex`, the local font copy and `pdftotext` (`test/cdm-local-tex.ts`);
 * skips without them. Evidence:
 * `pnpm exec vitest run --project node packages/export-latex/src/exp-115-body-end.compile.test.ts`
 * with `DOCEDIT_LUALATEX` and `DOCEDIT_PDFTOTEXT` set when they are not on the PATH.
 */
import { describe, expect, it } from 'vitest';
import { doc, para, type J } from '../test/docs.ts';
import { compileLocalAsync, convertLocal, lualatexAvailable } from '../test/cdm-local-tex.ts';
import { loadSemantics, pdftotextAvailable } from '../test/exp-115-fixtures.ts';
import { pdfText } from '../test/harness.ts';

interface Frame {
  readonly id: string;
  readonly description: string;
  readonly pageSetup: Readonly<Record<string, number | boolean>>;
  readonly headerHeight: number;
  readonly footerHeight: number;
  readonly expected: { readonly top?: number; readonly bottom?: number; readonly height?: number };
}

/** The frames that give where the body ends and leave it room. */
const FRAMES = loadSemantics<{ frames: Frame[] }>('header-growth').frames.filter(
  (f) => f.expected.bottom !== undefined && f.expected.height !== 0,
);
const ready = lualatexAvailable() && pdftotextAvailable();

const A4: Record<string, number> = {
  width: 11906,
  height: 16838,
  marginTop: 1440,
  marginBottom: 1440,
  marginLeft: 1440,
  marginRight: 1440,
  gutter: 0,
  headerDistance: 708,
  footerDistance: 708,
};

/** Line heights in twips, from the largest, that put the height `h` just above or below a whole number of lines. */
function lineHeights(h: number): { above: number; below: number } {
  const MARGIN = 3;
  let above = 0;
  let below = 0;
  for (let l = 500; l >= 100 && (above === 0 || below === 0); l--) {
    const r = h % l;
    if (above === 0 && r >= MARGIN && r < MARGIN + 5) above = l;
    if (below === 0 && l - r >= MARGIN && l - r < MARGIN + 5) below = l;
  }
  if (above === 0 || below === 0) throw new Error(`no line height for a body of ${h} twips`);
  return { above, below };
}

async function linesOnPage(f: Frame, lineHeight: number, name: string): Promise<number> {
  const attrs = { id: 'ps1', ...A4, ...f.pageSetup } as Record<string, unknown>;
  const stories: J[] = [];
  if (f.headerHeight > 0) {
    stories.push({
      type: 'story',
      attrs: { id: 'h1' },
      content: [para('Header.', { lineRule: 'exact', lineSpacing: f.headerHeight })],
    });
    attrs['headerDefault'] = 'h1';
  }
  if (f.footerHeight > 0) {
    stories.push({
      type: 'story',
      attrs: { id: 'f1' },
      content: [para('Footer.', { lineRule: 'exact', lineSpacing: f.footerHeight })],
    });
    attrs['footerDefault'] = 'f1';
  }
  const pageHeight = Number(attrs['height']);
  const count = Math.ceil(pageHeight / lineHeight) + 3;
  const body = Array.from({ length: count }, (_, i) =>
    para(`Row${String(i + 1).padStart(4, '0')}`, {
      lineRule: 'exact',
      lineSpacing: lineHeight,
      spaceBefore: 0,
      spaceAfter: 0,
    }),
  );
  const envelope = doc(body, { pageSetups: [{ type: 'page_setup', attrs }], stories });
  const bundle = await convertLocal(envelope, {
    profile: 'preview',
    title: `exp-115-${name}`,
    instant: '2026-11-06T10:00:00.000Z',
    timeZone: 'Europe/London',
    suggestions: 'accept',
    layout: 'block',
    assets: {},
  } as never);
  const compiled = await compileLocalAsync(bundle, name);
  if (!compiled.ok || !compiled.pdf)
    throw new Error(`the compile failed (${compiled.dir}):\n${compiled.log.slice(-1500)}`);
  const text = pdfText(compiled.pdf);
  if (text === null) throw new Error('pdftotext failed');
  return (text.split('\f')[0]!.match(/Row\d{4}/g) ?? []).length;
}

describe.skipIf(!ready)('EXP-115 criterion 1: the end of the body read in the PDF', () => {
  for (const f of FRAMES) {
    const height = f.expected.bottom! - f.expected.top!;
    const { above, below } = lineHeights(height);
    for (const [kind, lineHeight] of [
      ['just above a whole number of lines', above],
      ['just below a whole number of lines', below],
    ] as const) {
      it.concurrent(
        `[header-growth x LaTeX] body end ${f.id}: ${kind} (lines of ${lineHeight} twips)`,
        async () => {
          const n = await linesOnPage(f, lineHeight, `body-end-${f.id}-${lineHeight}`);
          expect(n, `${f.description} Body height ${height}.`).toBe(
            Math.floor(height / lineHeight),
          );
        },
        600_000,
      );
    }
  }
});
