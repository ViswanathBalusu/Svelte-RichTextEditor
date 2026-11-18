/**
 * The plain form of a heading in a bookmark, a table of contents entry and a caption list entry, in
 * the compiled PDF (Node.js only, sandbox): EXP-022 criterion 2. The plain form is the typed text of
 * the heading, written through `pdfString` (owner decision 209: one string emitter for titles). A
 * bold run, TeX special characters, a footnote, inline math and a backslash must not change it: a
 * footnote and inline math add no text to it, and a backslash stays a backslash.
 *
 * The bundle is compiled in the export worker's sandbox (Podman) through `test/harness.ts`; the
 * outline is read with `test/exp-023-pdf-links.ts` and the entries with `pdftotext`. The tests skip
 * when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { doc, nid, para, type J } from '../test/docs.ts';
import { pdfLinks } from '../test/exp-023-pdf-links.ts';
import { convertAndCompile, keep, pdfText, sandboxReady } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';
const FIRST = 'Bold part of 50% & #1 $x';
const SECOND = 'Back\\slash and braces { }';
const CAPTION = 'Chart & 50% #1 {a}';

const STYLES: J[] = [
  {
    type: 'style_def',
    attrs: {
      id: 'H1',
      kind: 'paragraph',
      name: 'Heading 1',
      builtIn: true,
      outlineLevel: 1,
      bold: true,
    },
  },
];

const footnote = (text: string): J => ({
  type: 'footnote',
  attrs: { id: nid('f') },
  content: [{ type: 'paragraph', attrs: { id: nid('q') }, content: [{ type: 'text', text }] }],
});

describe.skipIf(!ready)(
  'EXP-022 criterion 2: the plain form of a heading in a bookmark, a contents entry and a caption list',
  () => {
    let pdf: Uint8Array;
    let text: string;
    beforeAll(async () => {
      const body: J[] = [
        { type: 'toc', attrs: { id: nid('c'), minLevel: 1, maxLevel: 1, of: 'headings' } },
        { type: 'toc', attrs: { id: nid('c'), of: 'Figure' } },
        para('', { style: 'H1', pageBreakBefore: true }, [
          { type: 'text', text: 'Bold', marks: [{ type: 'bold' }] },
          { type: 'text', text: ' part of ' },
          { type: 'equation', attrs: { latex: 'x^2' } },
          { type: 'text', text: '50% & #1 $x' },
          footnote('A note on the heading.'),
        ]),
        para('Body text under the first heading.'),
        para('', { style: 'H1' }, [{ type: 'text', text: SECOND }]),
        para('Body text under the second heading.'),
        {
          type: 'figure',
          attrs: { id: nid('f'), width: 1440, height: 1440, alt: 'A chart' },
          content: [
            {
              type: 'caption',
              content: [
                { type: 'text', text: 'Figure ' },
                { type: 'field', attrs: { id: nid('f'), kind: 'seq', name: 'Figure' } },
                { type: 'text', text: ': ' },
                { type: 'text', text: 'Chart', marks: [{ type: 'bold' }] },
                { type: 'text', text: ' & 50% #1 {a}' },
              ],
            },
          ],
        },
      ];
      const c = await convertAndCompile(doc(body, { styles: STYLES }), {
        profile: 'final',
        title: 'exp-022-plain-forms',
        instant: INSTANT,
        timeZone: 'Europe/London',
        suggestions: 'accept',
      } as never);
      if (!c.compile.ok || !c.compile.pdf)
        throw new Error(
          `the compile failed (${keep('exp-022-plain-forms', c)}):\n${c.compile.log.slice(-1500)}`,
        );
      pdf = c.compile.pdf;
      text = pdfText(pdf) ?? '';
    }, 600_000);

    it('gives a heading with formatting, a footnote, math and special characters its typed text as the bookmark', () => {
      const { outline } = pdfLinks(pdf);
      expect(outline[0]?.title).toBe(FIRST);
    });

    it('gives a heading with a backslash and braces its typed text as the bookmark', () => {
      const { outline } = pdfLinks(pdf);
      expect(outline[1]?.title).toBe(SECOND);
    });

    it('lists the typed text of the headings in the table of contents', () => {
      const first = text.split('\f')[0] ?? '';
      expect(first).toContain(FIRST);
      expect(first).toContain(SECOND);
    });

    it('lists the typed text of a caption in the list of figures', () => {
      const first = text.split('\f')[0] ?? '';
      expect(first).toContain(CAPTION);
    });
  },
);
