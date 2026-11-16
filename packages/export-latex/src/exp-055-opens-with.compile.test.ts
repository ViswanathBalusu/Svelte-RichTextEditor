/**
 * EXP-055 criterion 2, `opensWith` (lane w2; Node.js only, sandbox): the first material of a page
 * is not always body text, and `layout.json` says which it is. One document is compiled in the
 * export worker's sandbox (Podman) and its `layout.json` is read as the job would serve it:
 *
 * - `text`: the first page, and a page that opens inside a long paragraph;
 * - `tableHead`: the pages a long table continues on, which open with its repeated header row;
 * - `float`: the page a floating figure is placed at the top of;
 * - `footnoteContinuation`: the page that holds the rest of a long footnote.
 *
 * Each page also has `n` in order and a `setup`, and where a page has body text its `starts` names
 * a block of the body, never the figure or the footnote. The PDF is read too (`pdftotext`, a page at
 * a time), so that the report is checked against what the page shows and not only against itself.
 *
 * The test skips when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { doc, nid, para, type J } from '../test/docs.ts';
import { convertAndCompile, firstError, sandboxReady } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const words = (tag: string, count: number): string =>
  Array.from({ length: count }, (_v, i) => `${tag}${i}`).join(' ');

/** The text of each page of a PDF, by `pdftotext -raw`. */
function pageTexts(pdf: Uint8Array, pages: number): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'docedit-exp-055-opens-'));
  const file = join(dir, 'main.pdf');
  writeFileSync(file, pdf);
  const out: string[] = [];
  for (let n = 1; n <= pages; n++) {
    const r = spawnSync(
      'pdftotext',
      ['-enc', 'UTF-8', '-raw', '-f', String(n), '-l', String(n), file, '-'],
      { encoding: 'utf8', timeout: 60_000 },
    );
    if (r.error || r.status !== 0) throw new Error('pdftotext is not installed or failed');
    out.push(r.stdout);
  }
  return out;
}

/** The first line of a page's text that is not empty. */
const firstLine = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '') ?? '';

describe.skipIf(!ready)(
  'EXP-055 criterion 2: opensWith tells text, a float, a repeated table head and a footnote continuation apart',
  () => {
    it('reports each of the four on the page that shows it', async () => {
      const intro = para('INTROWORD starts the document.');
      const table: J = {
        type: 'table',
        attrs: { id: nid('t'), grid: [2880, 2880], headerRows: 1 },
        content: Array.from({ length: 120 }, (_v, r) => ({
          type: 'table_row',
          attrs: { id: nid('r') },
          content: [0, 1].map((col) => ({
            type: 'table_cell',
            attrs: { id: nid('c') },
            content: [para(r === 0 ? `HEADCELL${col}` : `row${r}col${col}`)],
          })),
        })),
      };
      const long = para(words('body', 900));
      const figure: J = {
        type: 'figure',
        attrs: { id: nid('fig'), width: 2880, height: 1440, alt: 'A map', placement: 'float' },
        content: [
          {
            type: 'caption',
            attrs: { id: nid('cap') },
            content: [{ type: 'text', text: 'FLOATCAPTION' }],
          },
        ],
      };
      const after = para(words('after', 700));
      const noted: J = {
        type: 'paragraph',
        attrs: { id: nid('p') },
        content: [
          { type: 'text', text: 'NOTEDWORD carries a long note.' },
          {
            type: 'footnote',
            attrs: { id: nid('f') },
            content: [
              {
                type: 'paragraph',
                attrs: { id: nid('q') },
                content: [{ type: 'text', text: words('note', 900) }],
              },
            ],
          },
        ],
      };
      const body = [intro, table, long, figure, after, noted];
      const c = await convertAndCompile(
        doc(body),
        {
          profile: 'preview',
          title: 'exp-055-opens-with',
          instant: '2026-11-06T10:00:00.000Z',
          timeZone: 'Europe/London',
          suggestions: 'accept',
          layout: 'line',
        } as never,
        { minPasses: 2 },
      );
      if (!c.compile.ok || !c.compile.pdf)
        throw new Error(`the compile failed: ${firstError(c.compile.log)}`);
      expect(c.layoutErrors).toEqual([]);
      const pages = c.layout!.pages;
      const texts = pageTexts(c.compile.pdf, pages.length);

      // n in order, a setup on every page.
      expect(pages.map((p) => p.n)).toEqual(pages.map((_p, i) => i + 1));
      for (const p of pages) expect(p.setup, `page ${p.n}`).not.toBeNull();

      const idOf = (node: J): string => String((node['attrs'] as J)['id']);
      const opens = pages.map((p) => p.opensWith);

      // text: the first page starts at the first block, offset 0.
      expect(opens[0]).toBe('text');
      expect(pages[0]!.starts).toMatchObject({ blockId: idOf(intro), offset: 0 });
      expect(firstLine(texts[0]!)).toMatch(/^INTROWORD/);

      // tableHead: exactly the pages whose first line in the PDF is the repeated header row. The
      // table starts on page 1 under the intro, so page 1 is not one of them.
      const headPages = pages.filter((p) => p.opensWith === 'tableHead').map((p) => p.n);
      const shownHead = pages
        .filter((p) => p.n > 1 && /^HEADCELL0\s+HEADCELL1/.test(firstLine(texts[p.n - 1]!)))
        .map((p) => p.n);
      expect(headPages.length).toBeGreaterThanOrEqual(1);
      expect(headPages).toEqual(shownHead);

      // float: one page, the one whose text shows the caption before any body word; its `starts`
      // is a body paragraph, not the figure.
      const floatPages = pages.filter((p) => p.opensWith === 'float');
      expect(floatPages).toHaveLength(1);
      const floatPage = floatPages[0]!;
      const floatText = texts[floatPage.n - 1]!;
      expect(floatText).toContain('FLOATCAPTION');
      const firstBody = floatText.search(/\b(body|after)\d+\b/);
      expect(firstBody).toBeGreaterThan(floatText.indexOf('FLOATCAPTION'));
      expect([idOf(long), idOf(after)]).toContain(floatPage.starts?.blockId);
      expect(floatPage.starts!.offset).toBeGreaterThan(0);

      // text again: a page that opens inside the long paragraph.
      const inside = pages.find(
        (p) => p.n > 1 && p.opensWith === 'text' && p.starts?.blockId === idOf(long),
      );
      expect(inside, 'a page opens inside the long paragraph').toBeDefined();
      expect(inside!.starts!.offset).toBeGreaterThan(0);
      expect(firstLine(texts[inside!.n - 1]!)).toMatch(/^body\d+/);

      // footnoteContinuation: the pages after the one with the mark hold only the note's rest.
      const notePages = pages.filter((p) => p.opensWith === 'footnoteContinuation');
      expect(notePages.length).toBeGreaterThanOrEqual(1);
      for (const p of notePages) {
        expect(firstLine(texts[p.n - 1]!)).toMatch(/^note\d+/);
        expect(texts[p.n - 1]!).not.toMatch(/\b(body|after)\d+\b/);
      }

      // Nothing else: every page is one of the four, and the pages not named above open with text.
      for (const p of pages) {
        if (headPages.includes(p.n) || p === floatPage || notePages.includes(p)) continue;
        expect(p.opensWith, `page ${p.n}`).toBe('text');
        expect(firstLine(texts[p.n - 1]!)).not.toMatch(/^(HEADCELL|FLOATCAPTION|note\d)/);
      }
    }, 600_000);
  },
);
