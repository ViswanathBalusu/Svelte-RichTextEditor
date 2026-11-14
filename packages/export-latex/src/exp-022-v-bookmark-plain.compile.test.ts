/**
 * Bookmark text of headings in the compiled PDF (Node.js, sandbox): EXP-022 criterion 2, the plain
 * form of a heading in a bookmark. Lane V-EXP-017-032 (2026-11-13). The first heading has a bold
 * run and TeX special characters; its bookmark must be the typed text. The second heading has a
 * backslash; its bookmark is not yet the typed text (recorded as `it.fails`, see the story Notes).
 * The outline is read from the compiled PDF with `test/exp-023-pdf-links.ts`.
 *
 * The tests skip when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { doc, para, type J } from '../test/docs.ts';
import { pdfLinks } from '../test/exp-023-pdf-links.ts';
import { convertAndCompile, keep, sandboxReady, type Compiled } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';
const FIRST = 'Bold part and & 50% #1 $x$';
const SECOND = 'Back\\slash and braces { }';

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

describe.skipIf(!ready)(
  'EXP-022 criterion 2: the bookmark text is the plain text of the heading',
  () => {
    let c: Compiled;
    beforeAll(async () => {
      const body = [
        para('', { style: 'H1' }, [
          { type: 'text', text: 'Bold', marks: [{ type: 'bold' }] },
          { type: 'text', text: ' part and & 50% #1 $x$' },
        ]),
        para('Body text under the first heading.'),
        para('', { style: 'H1' }, [{ type: 'text', text: SECOND }]),
        para('Body text under the second heading.'),
      ];
      c = await convertAndCompile(doc(body, { styles: STYLES }), {
        profile: 'preview',
        title: 'exp-022-v-bookmark-plain',
        instant: INSTANT,
        timeZone: 'Europe/London',
        suggestions: 'accept',
      } as never);
      expect(
        c.compile.ok,
        `the compile failed (${keep('exp-022-v-bookmark-plain', c)}):\n${c.compile.log.slice(-1500)}`,
      ).toBe(true);
    }, 300_000);

    it('gives a heading with a bold run and special characters its typed text in the outline', () => {
      const { outline } = pdfLinks(c.compile.pdf!);
      expect(outline[0]?.title).toBe(FIRST);
    });

    it.fails(
      'gives a heading with a backslash its typed text in the outline (known defect, EXP-022 Notes)',
      () => {
        const { outline } = pdfLinks(c.compile.pdf!);
        expect(outline[1]?.title).toBe(SECOND);
      },
    );
  },
);
