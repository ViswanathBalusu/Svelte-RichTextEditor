/**
 * Tables of contents and lists of captions in the compiled PDF (Node.js only, sandbox): EXP-023
 * criteria 1, 2, 3 and 5. The converter's bundle is compiled in the export worker's sandbox (Podman)
 * through `test/harness.ts`, and the PDF is read with `pdftotext` (per page, from its form feeds) and
 * with `test/exp-023-pdf-links.ts` (each page's link annotations, their destinations resolved to
 * pages through the named destinations, and the outline).
 *
 * - Criterion 1: a table of headings in a level range lists those headings, with their page numbers.
 * - Criterion 2: a list of a caption sequence lists its captions.
 * - Criterion 3: in the final profile as well as in the preview, the page numbers of the entries are
 *   the pages the headings are on (the compile repeats until the references settle).
 * - Criterion 5: each entry is a link annotation on the table's page, and its destination is on the
 *   page of its heading or caption; a heading entry's destination is the heading's own (the one its
 *   bookmark goes to).
 *
 * Criterion 4 (a one-pass preview says that its entries may be stale) is not covered: it needs
 * EXP-062, which is not built.
 *
 * The tests skip when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 * Work of lane U-EXP-017-032.
 */
import { describe, expect, it } from 'vitest';
import { doc, nid, para, type J } from '../test/docs.ts';
import { pdfLinks, type PdfLink } from '../test/exp-023-pdf-links.ts';
import { convertAndCompile, keep, pdfText, sandboxReady, validatePdf } from '../test/harness.ts';

const readiness = await sandboxReady();
if (!readiness.ok) console.warn(`skipped: ${readiness.reason}`);
const ready = readiness.ok;

const INSTANT = '2026-11-06T10:00:00.000Z';

/** The PDF text of each page, split at the form feeds of `pdftotext`, without a trailing empty page. */
function pages(text: string): string[] {
  const parts = text.split('\f');
  if (parts.length > 0 && parts[parts.length - 1]!.trim() === '') parts.pop();
  return parts;
}

/** A paragraph style with an outline level, based on Normal. */
function heading(id: string, level: number): J {
  return {
    type: 'style_def',
    attrs: {
      id,
      kind: 'paragraph',
      name: `Heading ${level}`,
      builtIn: true,
      outlineLevel: level,
      bold: true,
    },
  };
}

const headingPara = (style: string, text: string, attrs: J = {}): J =>
  para(text, { style, ...attrs });
const toc = (attrs: J): J => ({ type: 'toc', attrs: { id: nid('c'), ...attrs } });
const field = (attrs: J): J => ({ type: 'field', attrs: { id: nid('f'), ...attrs } });

/** A figure with no picture (so no asset is needed), an alternative text, and a caption. */
function figure(caption: J[]): J {
  return {
    type: 'figure',
    attrs: { id: nid('f'), width: 1440, height: 1440, alt: 'A map' },
    content: [{ type: 'caption', content: caption }],
  };
}

/** Compiles a document in one profile; returns the text of each page and the PDF bytes. */
async function compiled(body: J[], styles: J[], profile: 'preview' | 'final', name: string) {
  const c = await convertAndCompile(doc(body, { styles }), {
    profile,
    title: name,
    instant: INSTANT,
    timeZone: 'Europe/London',
    suggestions: 'accept',
  } as never);
  const dir = keep(name, c);
  if (!c.compile.ok || !c.compile.pdf)
    throw new Error(`the compile failed (${dir}):\n${c.compile.log.slice(-1500)}`);
  const text = pdfText(c.compile.pdf);
  if (text === null) throw new Error('pdftotext is not installed or failed');
  return { pages: pages(text), pdf: c.compile.pdf };
}

const PROFILES = ['preview', 'final'] as const;

describe.skipIf(!ready)(
  'EXP-023 criteria 1 and 3: a table of headings lists them with their page numbers',
  () => {
    it.each(PROFILES)(
      'lists the headings of the range with the page each is on (%s profile)',
      async (profile) => {
        const styles = [heading('H1', 1), heading('H2', 2)];
        const body = [
          toc({ minLevel: 1, maxLevel: 2, of: 'headings' }),
          headingPara('H1', 'Introduction'),
          para('Some body text.'),
          headingPara('H2', 'Background'),
          headingPara('H1', 'Results', { pageBreakBefore: true }),
          para('The results.'),
        ];
        const { pages: pg } = await compiled(
          body,
          styles,
          profile,
          `exp-023-toc-headings-${profile}`,
        );
        expect(pg.length).toBeGreaterThanOrEqual(2);
        // The table is on page 1: the entries name the headings and give their pages (Results is on page 2).
        expect(pg[0]).toMatch(/Introduction[\s.]*1\b/);
        expect(pg[0]).toMatch(/Background[\s.]*1\b/);
        expect(pg[0]).toMatch(/Results[\s.]*2\b/);
        expect(pg[1]).toContain('Results');
      },
      300_000,
    );
  },
);

describe.skipIf(!ready)(
  'EXP-023 criterion 2: a table of a caption sequence lists its captions',
  () => {
    it('lists the figure captions on page 1, before the body starts on page 2', async () => {
      const body = [
        toc({ of: 'Figure' }),
        para('Body start', { pageBreakBefore: true }),
        figure([
          { type: 'text', text: 'Figure ' },
          field({ kind: 'seq', name: 'Figure' }),
          { type: 'text', text: ': Alpha map' },
        ]),
        figure([
          { type: 'text', text: 'Figure ' },
          field({ kind: 'seq', name: 'Figure' }),
          { type: 'text', text: ': Beta map' },
        ]),
      ];
      const { pages: pg } = await compiled(body, [], 'preview', 'exp-023-toc-figures');
      expect(pg.length).toBeGreaterThanOrEqual(2);
      expect(pg[0]).toContain('Alpha map');
      expect(pg[0]).toContain('Beta map');
      expect(pg[0]).not.toContain('Body start');
    }, 300_000);
  },
);

/** The page (from 0) whose text contains `needle` after the table's page, or -1. */
const pageOf = (pg: string[], needle: string): number =>
  pg.findIndex((t, i) => i > 0 && t.includes(needle));

/** The links of a page, top first (a PDF rectangle's y grows upwards). */
const topFirst = (links: PdfLink[], page: number): PdfLink[] =>
  links.filter((l) => l.page === page).sort((a, b) => b.rect[3] - a.rect[3]);

describe.skipIf(!ready)('EXP-023 criterion 5: every entry links to its heading or caption', () => {
  it.each(PROFILES)(
    'links each heading entry to its heading, on the heading page (%s profile)',
    async (profile) => {
      const styles = [heading('H1', 1)];
      const body = [
        toc({ minLevel: 1, maxLevel: 1, of: 'headings' }),
        headingPara('H1', 'Introduction', { pageBreakBefore: true }),
        headingPara('H1', 'Method', { pageBreakBefore: true }),
        headingPara('H1', 'Results', { pageBreakBefore: true }),
      ];
      const { pages: pg, pdf } = await compiled(
        body,
        styles,
        profile,
        `exp-023-toc-links-${profile}`,
      );
      const titles = ['Introduction', 'Method', 'Results'];
      const where = titles.map((t) => pageOf(pg, t));
      expect(where).toEqual([1, 2, 3]);
      const { links, outline } = pdfLinks(pdf);
      // One link annotation per entry on the table's page, in the order of the entries.
      const toc1 = topFirst(links, 0);
      expect(toc1).toHaveLength(3);
      for (const [i, title] of titles.entries()) {
        const link = toc1[i]!;
        // The destination is on the heading's page...
        expect(link.destPage, title).toBe(where[i]);
        // ...and is the heading's own destination, the one its bookmark (EXP-022) goes to.
        const mark = outline.find((o) => o.title === title);
        expect(mark, `the bookmark of ${title}`).toBeDefined();
        expect(link.destName, title).not.toBeNull();
        expect(link.destName, title).toBe(mark!.destName);
      }
      // No other page has links: the headings themselves are not links.
      expect(links.filter((l) => l.page !== 0)).toEqual([]);
      // The class's own entry line calls the kernel's hooks, so the tagged PDF stays valid with them.
      if (profile === 'final') {
        const v = await validatePdf(pdf, 'ua2');
        expect(v.failures, JSON.stringify(v)).toEqual([]);
        expect(v.compliant).toBe(true);
      }
    },
    600_000,
  );

  it('links each caption entry to its caption, on the caption page', async () => {
    const body = [
      toc({ of: 'Figure' }),
      para('Body start', { pageBreakBefore: true }),
      figure([
        { type: 'text', text: 'Figure ' },
        field({ kind: 'seq', name: 'Figure' }),
        { type: 'text', text: ': Alpha map' },
      ]),
      para('Second part', { pageBreakBefore: true }),
      figure([
        { type: 'text', text: 'Figure ' },
        field({ kind: 'seq', name: 'Figure' }),
        { type: 'text', text: ': Beta map' },
      ]),
    ];
    const { pages: pg, pdf } = await compiled(body, [], 'preview', 'exp-023-lof-links');
    const where = ['Alpha map', 'Beta map'].map((t) => pageOf(pg, t));
    expect(where).toEqual([1, 2]);
    const { links } = pdfLinks(pdf);
    const lof = topFirst(links, 0);
    expect(lof).toHaveLength(2);
    expect(lof.map((l) => l.destPage)).toEqual(where);
    // Two captions, two destinations.
    expect(lof[0]!.destName).not.toBe(lof[1]!.destName);
  }, 300_000);
});
