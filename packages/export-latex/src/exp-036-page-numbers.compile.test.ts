/**
 * Page number start and page number format in the compiled PDF (Node.js only, sandbox): EXP-036
 * criterion 1. The converter's bundle is compiled in the export worker's sandbox (Podman) through
 * `test/harness.ts`; the page text is read back with `pdftotext` (split at its form feeds). The
 * header prints `Page {page}`, so the page's number is the text after "Page ".
 *
 * - Criterion 1: the pages of a section are numbered from its pageNumberStart, in its
 *   pageNumberFormat, and a second section uses its own start and format.
 *
 * The tests skip when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import { describe, expect, it } from 'vitest';
import { doc, nid, para, type J } from '../test/docs.ts';
import { convertAndCompile, keep, pdfText, sandboxReady, type Compiled } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';
const A4: J = {
  width: 11906,
  height: 16838,
  marginTop: 1440,
  marginBottom: 1440,
  marginLeft: 1440,
  marginRight: 1440,
  gutter: 0,
  headerDistance: 720,
  footerDistance: 720,
};

const story = (id: string, paragraphs: J[]): J => ({
  type: 'story',
  attrs: { id },
  content: paragraphs,
});
const pageSetup = (id: string, attrs: J): J => ({
  type: 'page_setup',
  attrs: { id, ...A4, headerDefault: 'h1', ...attrs },
});
const sectionBreak = (pageSetupId: string): J => ({
  type: 'section_break',
  attrs: { id: nid('s'), pageSetup: pageSetupId },
});

/** The header of every page: "Page " and the page's number, in the page setup's format. */
const header = (): J =>
  story('h1', [para('Page ', {}, [{ type: 'field', attrs: { id: nid('f'), kind: 'page' } }])]);

const INSTANT_OPTIONS = {
  profile: 'preview',
  title: 'exp-036-page-numbers',
  instant: INSTANT,
  timeZone: 'Europe/London',
  suggestions: 'accept',
  layout: 'block',
} as const;

async function compiled(name: string, envelope: ReturnType<typeof doc>): Promise<Compiled> {
  const c = await convertAndCompile(envelope, { ...INSTANT_OPTIONS, title: name } as never);
  if (!c.compile.ok || !c.compile.pdf)
    throw new Error(`the compile failed (${keep(name, c)}):\n${c.compile.log.slice(-1500)}`);
  return c;
}

/** The header text of each page, from `pdftotext`'s form feeds, without the empty trailing page. */
function pageHeaders(c: Compiled): string[] {
  const text = pdfText(c.compile.pdf!);
  if (text === null) throw new Error('pdftotext is not installed or failed');
  const parts = text.split('\f');
  if (parts.length > 0 && parts[parts.length - 1]!.trim() === '') parts.pop();
  return parts.map((p) => {
    const m = /Page\s+(\S+)/.exec(p);
    return m ? m[1]! : '';
  });
}

describe.skipIf(!ready)(
  'EXP-036 criterion 1: pageNumberStart and pageNumberFormat number the pages of their section',
  () => {
    it('numbers the pages of a section from pageNumberStart in decimal', async () => {
      const body = [
        para('One.'),
        para('Two.', { pageBreakBefore: true }),
        para('Three.', { pageBreakBefore: true }),
      ];
      const c = await compiled(
        'exp-036-decimal-start-5',
        doc(body, {
          pageSetups: [pageSetup('ps1', { pageNumberStart: 5, pageNumberFormat: 'decimal' })],
          stories: [header()],
        }),
      );
      expect(pageHeaders(c)).toEqual(['5', '6', '7']);
    }, 300_000);

    it('numbers the pages of a section in lowerRoman from pageNumberStart', async () => {
      const body = [
        para('One.'),
        para('Two.', { pageBreakBefore: true }),
        para('Three.', { pageBreakBefore: true }),
      ];
      const c = await compiled(
        'exp-036-lowerroman-start-4',
        doc(body, {
          pageSetups: [pageSetup('ps1', { pageNumberStart: 4, pageNumberFormat: 'lowerRoman' })],
          stories: [header()],
        }),
      );
      expect(pageHeaders(c)).toEqual(['iv', 'v', 'vi']);
    }, 300_000);

    it('gives a second section its own start and format', async () => {
      const body = [
        para('One.'),
        para('Two.', { pageBreakBefore: true }),
        sectionBreak('ps2'),
        para('Three.'),
        para('Four.', { pageBreakBefore: true }),
      ];
      const c = await compiled(
        'exp-036-two-sections',
        doc(body, {
          pageSetups: [
            pageSetup('ps1', { pageNumberStart: 1, pageNumberFormat: 'decimal' }),
            pageSetup('ps2', { pageNumberStart: 4, pageNumberFormat: 'upperRoman' }),
          ],
          stories: [header()],
        }),
      );
      expect(pageHeaders(c)).toEqual(['1', '2', 'IV', 'V']);
    }, 300_000);
  },
);
