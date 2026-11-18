/**
 * Heading levels 1 to 9 in the compiled PDF (Node.js only, sandbox): EXP-022 criterion 4. Nine
 * paragraphs, one at each outline level, are set with `\DEh`; the PDF's outline must hold nine
 * entries, in order, each nested one level deeper than the one before (depth 0 to 8), each with a
 * destination on a page. The class gives levels 6 to 9 sectioning commands of their own
 * (`\DE@defsec` in `class/docedit.cls`) with the level numbers 6 to 9, so hyperref nests them. The
 * tagging code names structure roles only to level 5, so levels 6 to 9 take the role of level 5
 * (the class comment says so); this test reads the outline, not the structure tree.
 *
 * The bundle is compiled in the export worker's sandbox (Podman) through `test/harness.ts`; the
 * outline is read with `test/exp-023-pdf-links.ts`. The test skips when `sandboxReady()` reports
 * that sandboxed compiles cannot run here (EXP-070).
 */
import { describe, expect, it } from 'vitest';
import { doc, para, type J } from '../test/docs.ts';
import { pdfLinks } from '../test/exp-023-pdf-links.ts';
import { convertAndCompile, keep, sandboxReady } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';

function heading(id: string, level: number): J {
  return {
    type: 'style_def',
    attrs: { id, kind: 'paragraph', name: `Heading ${level}`, builtIn: true, outlineLevel: level },
  };
}

describe.skipIf(!ready)(
  'EXP-022 criterion 4: headings from level 1 to level 9 in the PDF outline',
  () => {
    it('has nine outline entries, each one level deeper than the one before, in order', async () => {
      const styles = Array.from({ length: 9 }, (_v, i) => heading(`H${i + 1}`, i + 1));
      const titles = Array.from({ length: 9 }, (_v, i) => `Level ${i + 1} heading`);
      const body = titles.map((t, i) => para(t, { style: `H${i + 1}` }));
      const c = await convertAndCompile(doc(body, { styles }), {
        profile: 'preview',
        title: 'exp-022-levels',
        instant: INSTANT,
        timeZone: 'Europe/London',
        suggestions: 'accept',
      } as never);
      if (!c.compile.ok || !c.compile.pdf)
        throw new Error(
          `the compile failed (${keep('exp-022-levels', c)}):\n${c.compile.log.slice(-1500)}`,
        );
      const outline = pdfLinks(c.compile.pdf).outline;
      expect(outline.map((o) => o.title)).toEqual(titles);
      expect(outline.map((o) => o.depth)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
      for (const o of outline)
        expect(o.destPage, `${o.title} has a destination on a page`).not.toBeNull();
    }, 600_000);
  },
);
