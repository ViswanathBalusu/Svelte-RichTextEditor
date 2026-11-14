/**
 * Typeset checks that compile the converter's bundle in the export worker's sandbox (Podman) and
 * read the PDF text back with `pdftotext` (Node.js only). They cover:
 *
 * - EXP-042 criterion 5: a string of every special character comes out of the PDF as typed.
 * - EXP-027 criterion 2: `"`, `:`, `;`, `!` and `?` are unchanged in German and French, and no
 *   spacing is inserted.
 * - EXP-031 criteria 1 and 2: a line break continues the paragraph on the next line; a page break
 *   and `pageBreakBefore` start the following material on a new page. Criterion 3 (column breaks in
 *   a multi-column section) is not covered here.
 * - EXP-038 criterion 3: `headerRows` repeat at the top of each page a table continues on.
 *
 * The tests skip when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 * Each compile takes several seconds, so each property has a few fixed cases, not a fuzz loop.
 */
import { describe, expect, it } from 'vitest';
import { doc, nid, para, type J } from '../test/docs.ts';
import { convertAndCompile, pdfText, sandboxReady } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';

/** The PDF text of each page, from `pdftotext`'s form feeds, without the empty trailing page. */
function pages(text: string): string[] {
  const parts = text.split('\f');
  if (parts.length > 0 && parts[parts.length - 1]!.trim() === '') parts.pop();
  return parts;
}

/** Compiles a body in the preview profile and returns the PDF text, or fails the test. */
async function compiledText(body: unknown[], extra: J = {}): Promise<string> {
  const c = await convertAndCompile(doc(body), {
    profile: 'preview',
    title: 'typeset-check',
    instant: INSTANT,
    timeZone: 'Europe/London',
    suggestions: 'accept',
    ...extra,
  } as never);
  if (!c.compile.ok || !c.compile.pdf)
    throw new Error(`the compile failed:\n${c.compile.log.slice(-1500)}`);
  const text = pdfText(c.compile.pdf);
  if (text === null) throw new Error('pdftotext is not installed or failed');
  return text;
}

describe.skipIf(!ready)(
  'EXP-042 criterion 5: every special character comes out of the PDF as typed',
  () => {
    it.each([
      'a \\ b { c } d $ e & f # g _ h % i ^ j ~ k',
      '\\{\\}\\$\\&\\#\\_\\%\\^\\~\\\\',
      'Price: 5% & $3 #1 under_score ~tilde ^caret {brace}',
    ])(
      'round-trips %j through the PDF text',
      async (s) => {
        const text = await compiledText([para(s)]);
        expect(text.replace(/\s+$/, '')).toBe(s);
      },
      180_000,
    );
  },
);

describe.skipIf(!ready)(
  'EXP-027 criterion 2: babel shorthands are off, so punctuation is unchanged',
  () => {
    const marked = (tag: string, text: string): J =>
      para('', {}, [{ type: 'text', text, marks: [{ type: 'lang', attrs: { value: tag } }] }]);

    it('keeps the quotes and the punctuation of German unchanged, with no inserted spacing', async () => {
      const s = '"Guten Tag": ja; nein! Doch?';
      const text = await compiledText([marked('de', s)]);
      expect(text.replace(/\s+$/, '')).toBe(s);
    }, 180_000);

    it('keeps the spaces before the punctuation of French as typed, with no inserted spacing', async () => {
      const s = 'Bonjour : ça ; oui ! non ?';
      const text = await compiledText([marked('fr', s)]);
      expect(text.replace(/\s+$/, '')).toBe(s);
    }, 180_000);
  },
);

describe.skipIf(!ready)('EXP-031 criteria 1 and 2: breaks start new lines and pages', () => {
  it('continues a paragraph on the next line after a line break', async () => {
    const p = para('', {}, [
      { type: 'text', text: 'Alpha' },
      { type: 'break', attrs: { id: nid('br'), kind: 'line' } },
      { type: 'text', text: 'Beta' },
    ]);
    const text = await compiledText([p]);
    expect(text).toMatch(/Alpha\r?\nBeta/);
  }, 180_000);

  it('starts the material after a page break on a new page', async () => {
    const p = para('', {}, [
      { type: 'text', text: 'Before' },
      { type: 'break', attrs: { id: nid('br'), kind: 'page' } },
      { type: 'text', text: 'After' },
    ]);
    const pg = pages(await compiledText([p]));
    expect(pg.length).toBeGreaterThanOrEqual(2);
    expect(pg[0]).toContain('Before');
    expect(pg[0]).not.toContain('After');
    expect(pg[1]).toContain('After');
  }, 180_000);

  it('starts a paragraph with pageBreakBefore on a new page', async () => {
    const pg = pages(
      await compiledText([para('First page.'), para('Second page.', { pageBreakBefore: true })]),
    );
    expect(pg.length).toBeGreaterThanOrEqual(2);
    expect(pg[0]).toContain('First page.');
    expect(pg[0]).not.toContain('Second page.');
    expect(pg[1]).toContain('Second page.');
  }, 180_000);
});

describe.skipIf(!ready)(
  'EXP-038 criterion 3: header rows repeat on each page a table continues on',
  () => {
    it('repeats the header row at the top of every later page', async () => {
      const rows: J[] = [];
      for (let i = 0; i < 150; i++) {
        rows.push({
          type: 'table_row',
          attrs: { id: nid('r') },
          content: [
            {
              type: 'table_cell',
              attrs: { id: nid('c') },
              content: [para(i === 0 ? 'HEADROW' : `Body ${i}`)],
            },
            { type: 'table_cell', attrs: { id: nid('c') }, content: [para(`Cell ${i}`)] },
          ],
        });
      }
      const table: J = {
        type: 'table',
        attrs: { id: nid('t'), grid: [4000, 4000], headerRows: 1 },
        content: rows,
      };
      const pg = pages(await compiledText([table]));
      expect(pg.length).toBeGreaterThanOrEqual(2);
      for (const p of pg.slice(1)) {
        const firstLine = p.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
        expect(firstLine).toContain('HEADROW');
      }
    }, 300_000);
  },
);
