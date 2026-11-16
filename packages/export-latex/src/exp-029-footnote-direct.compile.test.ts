/**
 * EXP-029 criterion 1, the compile half (lane w2; Node.js only, sandbox): a footnote of a body
 * paragraph is set with `\footnote` (`\DEfn`), and a footnote of a table cell and of a heading with
 * `\footnotemark` and `\footnotetext` (`\DEfnmark`, `\DEfntext`). The document compiles in the
 * export worker's sandbox (Podman) and `pdftotext -raw` reads the page back: the three notes are at
 * the foot of the page, after the body, in order, each behind its own mark, and the marks 1, 2 and
 * 3 are in the text. The layout report is read too: it is valid and has one page. That the text
 * of a direct footnote is still marked as footnote material is shown by
 * `exp-029-footnote-continuation.compile.test.ts`, whose footnote is a direct one.
 *
 * The test skips when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import { describe, expect, it } from 'vitest';
import { doc, nid, para, type J } from '../test/docs.ts';
import { convertAndCompile, firstError, pdfText, sandboxReady } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const footnote = (text: string): J => ({
  type: 'footnote',
  attrs: { id: nid('f') },
  content: [{ type: 'paragraph', attrs: { id: nid('q') }, content: [{ type: 'text', text }] }],
});

describe.skipIf(!ready)(
  'EXP-029 criterion 1: direct footnotes and mark-and-text footnotes are both set in the PDF',
  () => {
    it('sets a body footnote, a table-cell footnote and a heading footnote at the foot of the page', async () => {
      const body: J[] = [
        para('HEADWORD', { style: 'Heading1' }, [footnote('HEADNOTE text.')]),
        para('BODYWORD', {}, [footnote('BODYNOTE text.')]),
        {
          type: 'table',
          attrs: { id: nid('t'), grid: [4320] },
          content: [
            {
              type: 'table_row',
              attrs: { id: nid('r') },
              content: [
                {
                  type: 'table_cell',
                  attrs: { id: nid('c') },
                  content: [para('CELLWORD', {}, [footnote('CELLNOTE text.')])],
                },
              ],
            },
          ],
        },
        para('LASTWORD'),
      ];
      const styles: J[] = [
        {
          type: 'style_def',
          attrs: { id: 'Heading1', kind: 'paragraph', name: 'Heading 1', outlineLevel: 1 },
        },
      ];
      const envelope = doc(body, { styles });
      const c = await convertAndCompile(
        envelope,
        {
          profile: 'preview',
          title: 'exp-029-footnote-direct',
          instant: '2026-11-06T10:00:00.000Z',
          timeZone: 'Europe/London',
          suggestions: 'accept',
          layout: 'line',
        } as never,
        { minPasses: 2 },
      );
      if (!c.compile.ok || !c.compile.pdf)
        throw new Error(`the compile failed: ${firstError(c.compile.log)}`);

      // The source has the three forms the PDF is then checked for.
      const main = c.bundle.files['main.tex']!;
      expect(main).toMatch(/\\DEfn\{\d+\}\{\d+\}\{2\}/);
      expect([...main.matchAll(/\\DEfnmark\{/g)]).toHaveLength(2);
      expect([...main.matchAll(/\\DEfntext\{/g)]).toHaveLength(2);

      const text = pdfText(c.compile.pdf);
      if (text === null) throw new Error('pdftotext is not installed or failed');
      const flat = text.replace(/\s+/g, ' ');
      // The marks follow their words in the text.
      expect(flat).toMatch(/HEADWORD ?1\b/);
      expect(flat).toMatch(/BODYWORD ?2\b/);
      expect(flat).toMatch(/CELLWORD ?3\b/);
      // The notes are after the body, in order, each behind its mark.
      const last = flat.indexOf('LASTWORD');
      const head = flat.search(/1 ?HEADNOTE text\./);
      const direct = flat.search(/2 ?BODYNOTE text\./);
      const cell = flat.search(/3 ?CELLNOTE text\./);
      expect(last).toBeGreaterThan(-1);
      expect(head).toBeGreaterThan(last);
      expect(direct).toBeGreaterThan(head);
      expect(cell).toBeGreaterThan(direct);

      // One page, opened by the heading's text; the layout report is valid.
      expect(c.layoutErrors).toEqual([]);
      expect(c.layout!.pages).toHaveLength(1);
      expect(c.layout!.pages[0]!.opensWith).toBe('text');
    }, 300_000);
  },
);
