/**
 * Bookmarks in the compiled PDF (Node.js only, sandbox): EXP-022 criterion 1. Every paragraph whose
 * style has an outline level is set with the class's sectioning macro (`\DEh`), and the PDF must
 * carry one outline entry for each, at its level. The bundle is compiled in the export worker's
 * sandbox (Podman) through `test/harness.ts`. The outline is read with `test/exp-023-pdf-links.ts`,
 * which parses the PDF's objects (object streams included) and walks the outline tree from the
 * catalogue's `/Outlines`.
 *
 * An earlier version of this test searched the bytes for `/Title (…)` and `/Title <…>` and found
 * nothing, and so recorded that the PDF had no outline. It has one: LuaTeX writes each outline
 * item's `/Title` as an indirect reference (`/Title 70 0 R`) to a literal string in an object
 * stream, which a byte search does not resolve.
 *
 * The tests skip when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import { describe, expect, it } from 'vitest';
import { doc, para, type J } from '../test/docs.ts';
import { pdfLinks } from '../test/exp-023-pdf-links.ts';
import { convertAndCompile, keep, sandboxReady } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';

/** A paragraph style with an outline level, based on Normal (as in exp-022-headings.test.ts). */
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

function headingPara(text: string, style: string): J {
  return para(text, { style });
}

describe.skipIf(!ready)(
  'EXP-022 criterion 1: the PDF has an outline entry for each heading',
  () => {
    it('puts each heading into the PDF outline, in order, at its level, with a destination on its page', async () => {
      const styles = [heading('H1', 1), heading('H2', 2), heading('H3', 3)];
      const headings = [
        headingPara('Alpha section', 'H1'),
        para('Body text under alpha.'),
        headingPara('Beta subsection', 'H2'),
        para('Body text under beta.'),
        headingPara('Gamma subsubsection', 'H3'),
        para('Body text under gamma.'),
        headingPara('Delta section', 'H1'),
      ];
      const c = await convertAndCompile(doc(headings, { styles }), {
        profile: 'preview',
        title: 'exp-022-bookmarks',
        instant: INSTANT,
        timeZone: 'Europe/London',
        suggestions: 'accept',
      } as never);
      // The compile must succeed: a failed compile is a failure of this test, never a pass.
      expect(
        c.compile.ok,
        `the compile failed (${keep('exp-022-bookmarks', c)}):\n${c.compile.log.slice(-1500)}`,
      ).toBe(true);
      expect(c.compile.pdf).not.toBeNull();
      // Each heading is set by the class's sectioning macro.
      expect(c.bundle.files['main.tex']!.match(/\\DEh\{/g) ?? []).toHaveLength(4);

      const { outline, pageCount } = pdfLinks(c.compile.pdf!);
      // One entry per heading, in document order, nested by outline level, and no body paragraph.
      expect(outline.map((o) => [o.title, o.depth])).toEqual([
        ['Alpha section', 0],
        ['Beta subsection', 1],
        ['Gamma subsubsection', 2],
        ['Delta section', 0],
      ]);
      // Each entry goes somewhere: its destination resolves to a page of the document.
      for (const o of outline) {
        expect(o.destPage, `destination of "${o.title}"`).not.toBeNull();
        expect(o.destPage!).toBeLessThan(pageCount);
      }
    }, 300_000);
  },
);
