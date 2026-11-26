/**
 * EXP-028 criterion 3, the `align` half, checked on the compiled PDF (Node.js only, sandbox): the
 * picture of a figure is set at the start, the centre or the end of the text width, as its `align`
 * says. Positions are the word boxes of `pdftotext -bbox`.
 *
 * The pictures are the converter's placeholder boxes (no asset is attached), which print their
 * alternative text; they go through the same `\DEfig` macro and the same alignment code as a real
 * picture. A plain paragraph gives the left edge of the text.
 *
 * Owner decision 149 (docs/owner-decisions-2026-11-15.md, ADR 0223 decision 12): `align` is the
 * picture's alone. The caption is set by its own style, as in the editor's layout
 * (`packages/layout/src/flow.ts`), and does not move; the test asserts that the three captions
 * start at the same x.
 *
 * The test skips when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { doc, nid, para, type J } from '../test/docs.ts';
import { convertAndCompile, keep, sandboxReady } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

interface Box {
  xMin: number;
  xMax: number;
}

/** The box of the first word that contains `text`, from `pdftotext -bbox`, or null. */
function wordBox(bbox: string, text: string): Box | null {
  const m = new RegExp(`<word xMin="([^"]*)" yMin="[^"]*" xMax="([^"]*)"[^>]*>[^<]*${text}`).exec(
    bbox,
  );
  return m === null ? null : { xMin: Number(m[1]), xMax: Number(m[2]) };
}

const figure = (align: string, alt: string): J => ({
  type: 'figure',
  attrs: { id: nid('fig'), width: 2880, height: 1440, alt, align, placement: 'here' },
  content: [
    {
      type: 'caption',
      attrs: { id: nid('cap') },
      content: [{ type: 'text', text: `Caption of ${alt}` }],
    },
  ],
});

describe.skipIf(!ready)(
  'EXP-028 criterion 3 (align): the picture of a figure is set where its align says',
  () => {
    it('sets start at the left edge, end at the right edge and centre midway between them', async () => {
      const c = await convertAndCompile(
        doc([
          para('LEFTEDGE'),
          figure('start', 'PICSTART'),
          figure('center', 'PICCENTRE'),
          figure('end', 'PICEND'),
        ]),
        {
          profile: 'preview',
          title: 'exp-028-figure-align',
          instant: '2026-11-06T10:00:00.000Z',
          timeZone: 'Europe/London',
          suggestions: 'accept',
        } as never,
      );
      if (!c.compile.ok || !c.compile.pdf)
        throw new Error(
          `the compile failed (${keep('exp-028-figure-align', c)}):\n${c.compile.log.slice(-1500)}`,
        );
      const dir = mkdtempSync(join(tmpdir(), 'docedit-exp028-align-'));
      const file = join(dir, 'main.pdf');
      writeFileSync(file, c.compile.pdf);
      const r = spawnSync('pdftotext', ['-enc', 'UTF-8', '-bbox', '-l', '1', file, '-'], {
        encoding: 'utf8',
        timeout: 60_000,
      });
      if (r.error || r.status !== 0) throw new Error('pdftotext is not installed or failed');
      const bbox = r.stdout;
      const page = /<page width="([^"]*)"/.exec(bbox);
      const edge = wordBox(bbox, 'LEFTEDGE');
      const start = wordBox(bbox, 'PICSTART');
      const centre = wordBox(bbox, 'PICCENTRE');
      const end = wordBox(bbox, 'PICEND');
      if (!page || !edge || !start || !centre || !end)
        throw new Error(`a word is missing from the PDF text:\n${bbox.slice(0, 3000)}`);
      const width = Number(page[1]);

      // The placeholder is a framed box that ends with the alternative text and a bracket, so
      // the word's right end is the box's right end less the frame (under 6 pt).
      // Start: the box begins at the left edge of the text; its last word ends left of the middle.
      expect(start.xMax).toBeLessThan(width / 2);
      // End: the box ends at the right edge of the text, which mirrors the left edge when the
      // margins are equal; the test does not assume that, and asks only that it lies far right.
      expect(end.xMax).toBeGreaterThan(width / 2);
      expect(end.xMax).toBeGreaterThan(start.xMax + 144);
      // The three boxes are the same but for the alternative text, so the right ends of the
      // start and the end boxes span the free width, and the centre box sits midway (within the
      // difference of the word lengths, a few points).
      const midway = (start.xMax + end.xMax) / 2;
      expect(Math.abs(centre.xMax - midway)).toBeLessThan(12);
      expect(centre.xMax).toBeGreaterThan(start.xMax + 72);
      expect(centre.xMax).toBeLessThan(end.xMax - 72);
      // The start box is at the left edge of the text: its first word begins within the frame's
      // width of the paragraph's first letter.
      const first = wordBox(bbox, '\\[figure:');
      expect(first).not.toBeNull();
      expect(Math.abs(first!.xMin - edge.xMin)).toBeLessThan(6);

      // Owner decision 149 (ADR 0223, decision 12): `align` is the picture's alone, so the caption
      // does not move. The three captions start at the same x whatever their figure's align.
      const captionStarts = [...bbox.matchAll(/<word xMin="([^"]*)"[^>]*>Caption<\/word>/g)].map(
        (m) => Number(m[1]),
      );
      expect(captionStarts).toHaveLength(3);
      expect(Math.max(...captionStarts) - Math.min(...captionStarts)).toBeLessThan(1);
    }, 300_000);
  },
);
