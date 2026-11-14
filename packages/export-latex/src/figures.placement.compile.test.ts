/**
 * Placement of a figure in the compiled PDF (Node.js only, sandbox): EXP-028 criterion 2, the
 * `here` branch. The converter's bundle is compiled in the export worker's sandbox (Podman) through
 * `test/harness.ts`. The figure's y position comes from the class's layout report (layout.json, in
 * twips from the top of the page), and the paragraphs around it give the expected range.
 *
 * - Criterion 2 (`here`): a figure with placement `here` appears between the paragraph before it
 *   and the paragraph after it, and its caption follows the figure in the PDF text. The float
 *   branch is not tested: the criterion says a float "may" move, so there is nothing to check.
 *
 * The picture is the converter's placeholder box, since no asset is attached. The same `\DEfig`
 * macro places a real picture, so the placement check does not depend on the picture's content.
 *
 * The tests skip when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import { describe, expect, it } from 'vitest';
import { doc, nid, para, type J } from '../test/docs.ts';
import { convertAndCompile, keep, pdfText, sandboxReady } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';

const figure = (placement: string): J => ({
  type: 'figure',
  attrs: { id: nid('fig'), width: 2880, height: 1440, alt: 'FIGALT', placement },
  content: [
    { type: 'caption', attrs: { id: nid('cap') }, content: [{ type: 'text', text: 'CAPHERE' }] },
  ],
});

describe.skipIf(!ready)(
  'EXP-028 criterion 2 (here): a figure with placement here appears where it occurs',
  () => {
    it('places the figure between the paragraphs around it, and its caption after the figure', async () => {
      const before = para('BEFOREPARA');
      const fig = figure('here');
      const after = para('AFTERPARA');
      const body = [before, fig, after];
      const c = await convertAndCompile(doc(body), {
        profile: 'preview',
        title: 'exp-028-placement-here',
        instant: INSTANT,
        timeZone: 'Europe/London',
        suggestions: 'accept',
        layout: 'block',
      } as never);
      if (!c.compile.ok || !c.compile.pdf)
        throw new Error(
          `the compile failed (${keep('exp-028-placement-here', c)}):\n${c.compile.log.slice(-1500)}`,
        );
      expect(c.layoutErrors).toEqual([]);

      const yOf = (id: string): number | undefined => c.layout?.blocks[id]?.y;
      const yBefore = yOf((before['attrs'] as J)['id'] as string);
      const yFig = yOf((fig['attrs'] as J)['id'] as string);
      const yAfter = yOf((after['attrs'] as J)['id'] as string);
      expect(yBefore).toBeTypeOf('number');
      expect(yFig).toBeTypeOf('number');
      expect(yAfter).toBeTypeOf('number');
      expect(yFig!).toBeGreaterThan(yBefore!);
      expect(yFig!).toBeLessThan(yAfter!);

      const text = pdfText(c.compile.pdf);
      if (text === null) throw new Error('pdftotext is not installed or failed');
      const at = (s: string): number => text.indexOf(s);
      expect(at('BEFOREPARA')).toBeGreaterThanOrEqual(0);
      expect(at('BEFOREPARA')).toBeLessThan(at('CAPHERE'));
      expect(at('CAPHERE')).toBeLessThan(at('AFTERPARA'));
    }, 300_000);
  },
);
