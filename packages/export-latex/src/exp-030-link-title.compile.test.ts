/**
 * A link title in the compiled PDF (Node.js only, sandbox): EXP-030 criterion 5. The title is written
 * through `pdfString` (owner decision 209: one string emitter for titles) and the class turns it into
 * the link annotation's `/Contents` with hyperref's own text conversion. Each annotation's
 * `/Contents` is read with `test/exp-023-pdf-links.ts` and must be the typed title, whatever TeX
 * characters, backslashes, braces and non-ASCII letters it holds. (A title on an in-document link is
 * not written to the PDF: `DElink` has no `/Contents` socket.)
 *
 * The tests skip when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import { describe, expect, it } from 'vitest';
import { doc, para, type J } from '../test/docs.ts';
import { pdfLinks } from '../test/exp-023-pdf-links.ts';
import { convertAndCompile, keep, sandboxReady } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';

function link(text: string, href: string, title?: string): J {
  return {
    type: 'text',
    text,
    marks: [{ type: 'link', attrs: { href, ...(title !== undefined ? { title } : {}) } }],
  };
}

const TITLES = [
  'Plain title',
  'Specials & 50% #1 $x ~ ^ _ {braces}',
  'Back\\slash and \\write18{x}',
  'Café über 中文',
];

describe.skipIf(!ready)(
  'EXP-030 criterion 5: a link title is written through pdfString and is the annotation contents',
  () => {
    it('gives each link annotation its typed title as /Contents', async () => {
      const body: J[] = [
        para('', {}, [link('First', 'https://example.com/1', TITLES[0])]),
        para('', {}, [link('Second', 'https://example.com/2', TITLES[1])]),
        para('', {}, [link('Third', 'mailto:ada@example.com', TITLES[2])]),
        para('', {}, [link('Fourth', 'https://example.com/4', TITLES[3])]),
      ];
      const c = await convertAndCompile(doc(body), {
        profile: 'preview',
        title: 'exp-030-link-title',
        instant: INSTANT,
        timeZone: 'Europe/London',
        suggestions: 'accept',
      } as never);
      if (!c.compile.ok || !c.compile.pdf)
        throw new Error(
          `the compile failed (${keep('exp-030-link-title', c)}):\n${c.compile.log.slice(-1500)}`,
        );
      // No raw title reaches a source file.
      for (const [name, text] of Object.entries(c.bundle.files))
        if (name.endsWith('.tex')) expect(text, name).not.toContain('\\write18');
      const contents = pdfLinks(c.compile.pdf).links.map((l) => l.contents);
      expect(contents).toEqual(TITLES);
    }, 600_000);
  },
);
