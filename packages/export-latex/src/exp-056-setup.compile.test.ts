/**
 * EXP-056 criterion 3 (lane w2; Node.js only, sandbox): the `setup` of each page in `layout.json`
 * is the page setup in force on that page.
 *
 * One document has two page setups, A4 portrait and Letter landscape, with a section break between
 * them, and enough text in each section to fill more than one page. The class writes the setup of
 * each page; the PDF is then read independently: the marker word that a page prints names its
 * section, and the size of the page in the PDF must be the size of that section's setup. A last
 * test shows that a wrong `setup` in `layout.json` is reported with the document's name and the
 * page's number (criterion 4, the message half).
 *
 * The test skips when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070), or
 * when poppler's `pdfinfo` and `pdftotext` are missing.
 */
import { describe, expect, it } from 'vitest';
import { doc, para, type J } from '../test/docs.ts';
import { convertAndCompile, keep, sandboxReady } from '../test/harness.ts';
import {
  popplerAvailable,
  setupMismatches,
  type LayoutPage,
  type SetupExpectation,
} from '../test/layout-pdf-check.ts';

const ready = popplerAvailable() && (await sandboxReady()).ok;

const NAME = 'exp-056-two-setups';
const MARGINS = {
  marginTop: 1440,
  marginBottom: 1440,
  marginLeft: 1440,
  marginRight: 1440,
  gutter: 0,
  headerDistance: 720,
  footerDistance: 720,
};
const setup = (id: string, attrs: J): J => ({
  type: 'page_setup',
  attrs: { id, ...MARGINS, ...attrs },
});
const A4 = setup('ps1', { width: 11906, height: 16838, orientation: 'portrait' });
const LETTER_LANDSCAPE = setup('ps2', { width: 15840, height: 12240, orientation: 'landscape' });

/** Paragraphs of 60 words each, every one starting with the section's marker word. */
const section = (marker: string, paragraphs: number): J[] =>
  Array.from({ length: paragraphs }, (_v, i) =>
    para(`${marker} ${Array.from({ length: 60 }, (_w, j) => `w${i}x${j}`).join(' ')}`),
  );

const EXPECTATIONS: SetupExpectation[] = [
  { setup: 'ps1', widthPt: 595.3, heightPt: 841.9, marker: 'SECTIONONE' },
  { setup: 'ps2', widthPt: 792, heightPt: 612, marker: 'SECTIONTWO' },
];

describe.skipIf(!ready)('EXP-056 criterion 3: setup is the page setup in force on the page', () => {
  it('reports ps1 on the pages of the A4 section and ps2 on those of the Letter landscape section, and names the page of a wrong one', async () => {
    const body = [
      ...section('SECTIONONE', 14),
      { type: 'section_break', attrs: { id: 'sb0000000000001x', pageSetup: 'ps2' } },
      ...section('SECTIONTWO', 14),
    ];
    const c = await convertAndCompile(
      doc(body, { pageSetups: [A4, LETTER_LANDSCAPE] }),
      {
        profile: 'preview',
        title: NAME,
        instant: '2026-11-06T10:00:00.000Z',
        timeZone: 'Europe/London',
        suggestions: 'accept',
        layout: 'block',
      } as never,
      { minPasses: 2 },
    );
    if (!c.compile.ok || !c.compile.pdf)
      throw new Error(`the compile failed (${keep(NAME, c)}):\n${c.compile.log.slice(-1500)}`);
    expect(c.layoutErrors).toEqual([]);
    const pages = c.layout!.pages as LayoutPage[];
    // Each section runs over more than one page, so that both setups are reported more than once.
    expect(pages.filter((p) => p.setup === 'ps1').length).toBeGreaterThanOrEqual(2);
    expect(pages.filter((p) => p.setup === 'ps2').length).toBeGreaterThanOrEqual(2);
    expect(setupMismatches(NAME, pages, c.compile.pdf, EXPECTATIONS)).toEqual([]);

    // Criterion 4, message half: a wrong setup is reported with the document and the page.
    const wrong = pages.map((p) => (p.n === 2 ? { ...p, setup: 'ps2' } : p));
    const found = setupMismatches(NAME, wrong, c.compile.pdf, EXPECTATIONS);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(NAME);
    expect(found[0]).toContain('page 2');
    expect(found[0]).toContain('"ps2"');
  }, 600_000);
});
