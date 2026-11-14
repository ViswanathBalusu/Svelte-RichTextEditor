/**
 * Headers and footers in the compiled PDF (Node.js only, sandbox): EXP-018 criteria 2 and 4. The
 * converter's bundle is compiled in the export worker's sandbox (Podman) through `test/harness.ts`.
 * The page text is read back with `pdftotext` (split at its form feeds), and the body position
 * from the class's layout report (layout.json, in twips from the top of the page).
 *
 * - Criterion 4: a header with `Page {page} of {pageCount}` shows its own number on each page.
 * - Criterion 2: a header taller than the space above the top margin moves the body down.
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

const field = (kind: string): J => ({ type: 'field', attrs: { id: nid('f'), kind } });
const story = (id: string, paragraphs: J[]): J => ({
  type: 'story',
  attrs: { id },
  content: paragraphs,
});
const setup = (attrs: J): J => ({ type: 'page_setup', attrs: { id: 'ps1', ...A4, ...attrs } });

async function compiled(name: string, body: J[], stories: J[], setupAttrs: J): Promise<Compiled> {
  const c = await convertAndCompile(doc(body, { pageSetups: [setup(setupAttrs)], stories }), {
    profile: 'preview',
    title: name,
    instant: INSTANT,
    timeZone: 'Europe/London',
    suggestions: 'accept',
    layout: 'block',
  } as never);
  if (!c.compile.ok || !c.compile.pdf)
    throw new Error(`the compile failed (${keep(name, c)}):\n${c.compile.log.slice(-1500)}`);
  return c;
}

/** The PDF text of each page, from `pdftotext`'s form feeds, without the empty trailing page. */
function pages(pdf: Uint8Array): string[] {
  const text = pdfText(pdf);
  if (text === null) throw new Error('pdftotext is not installed or failed');
  const parts = text.split('\f');
  if (parts.length > 0 && parts[parts.length - 1]!.trim() === '') parts.pop();
  return parts;
}

describe.skipIf(!ready)(
  'EXP-018 criterion 4: a header with page and pageCount fields shows each page its own number',
  () => {
    it('prints "Page n of 3" in the header of page n, for n = 1, 2 and 3', async () => {
      const header = story('h1', [
        para('Page ', {}, [field('page'), { type: 'text', text: ' of ' }, field('pageCount')]),
      ]);
      const body = [
        para('Body one.'),
        para('Body two.', { pageBreakBefore: true }),
        para('Body three.', { pageBreakBefore: true }),
      ];
      const c = await compiled('exp-018-page-fields', body, [header], { headerDefault: 'h1' });
      const pg = pages(c.compile.pdf!);
      expect(pg).toHaveLength(3);
      for (const [i, text] of pg.entries()) {
        expect(text).toContain(`Page ${i + 1} of 3`);
        // No other page's number is in this page's header.
        for (const other of [1, 2, 3].filter((n) => n !== i + 1))
          expect(text).not.toContain(`Page ${other} of`);
      }
      expect(pg[1]).toContain('Body two.');
    }, 300_000);
  },
);

describe.skipIf(!ready)(
  'EXP-018 criterion 2: a header taller than its space moves the body down (header growth)',
  () => {
    it('sets the first body block lower under a tall header than under a one-line header', async () => {
      const short = story('h1', [para('Short header')]);
      const tall = story(
        'h1',
        Array.from({ length: 12 }, (_, i) => para(`Tall header line ${i + 1}`)),
      );
      const target = (): J => para('First body paragraph.');
      const a = target();
      const b = target();
      const one = await compiled('exp-018-header-short', [a], [short], { headerDefault: 'h1' });
      const many = await compiled('exp-018-header-tall', [b], [tall], { headerDefault: 'h1' });
      expect(one.layoutErrors).toEqual([]);
      expect(many.layoutErrors).toEqual([]);
      const yShort = one.layout?.blocks[(a['attrs'] as J)['id'] as string]?.y;
      const yTall = many.layout?.blocks[(b['attrs'] as J)['id'] as string]?.y;
      expect(yShort).toBeTypeOf('number');
      expect(yTall).toBeTypeOf('number');
      // The one-line header fits between the header distance (720) and the top margin (1440), so the
      // body starts at the margin; twelve header lines end far below 1440, so the body moves down.
      expect(yTall!).toBeGreaterThan(yShort! + 1440);
      // The tall header is all on the first page, above the body.
      const text = pages(many.compile.pdf!)[0]!;
      expect(text.indexOf('Tall header line 12')).toBeGreaterThanOrEqual(0);
      expect(text.indexOf('Tall header line 12')).toBeLessThan(
        text.indexOf('First body paragraph.'),
      );
    }, 300_000);
  },
);
