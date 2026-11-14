/**
 * Caption labels in the compiled PDF (Node.js, sandbox): EXP-028 criterion 3, the `seq` part only.
 * Lane V-EXP-017-032. The bundle is compiled in the export worker's sandbox (Podman) through
 * `test/harness.ts`, and the caption text is read back with `pdftotext`. The `align` part of the
 * criterion is not tested here: the owner has not decided whether `align` moves the caption
 * (ADR 0223, decision 12), so criterion 3 stays unticked.
 *
 * The tests skip when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import { describe, expect, it } from 'vitest';
import { doc, nid, type J } from '../test/docs.ts';
import { convertAndCompile, keep, pdfText, sandboxReady } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';

const seq = (): J => ({ type: 'field', attrs: { id: nid('f'), kind: 'seq', name: 'Figure' } });

const figure = (label: string): J => ({
  type: 'figure',
  attrs: { id: nid('fig'), width: 2880, height: 1440, alt: 'A map', placement: 'here' },
  content: [
    {
      type: 'caption',
      attrs: { id: nid('cap') },
      content: [{ type: 'text', text: `${label} Figure ` }, seq()],
    },
  ],
});

describe.skipIf(!ready)(
  'EXP-028 criterion 3 (seq): a caption shows the literal label in the PDF',
  () => {
    it('prints the labels 1 and 2 of two captions in order, with no TeX counter', async () => {
      const f1 = figure('FIRSTCAP');
      const f2 = figure('SECONDCAP');
      const c = await convertAndCompile(doc([f1, f2]), {
        profile: 'preview',
        title: 'exp-028-caption-seq',
        instant: INSTANT,
        timeZone: 'Europe/London',
        suggestions: 'accept',
        layout: 'block',
      } as never);
      if (!c.compile.ok || !c.compile.pdf) {
        throw new Error(
          `the compile failed (${keep('exp-028-caption-seq', c)}):\n${c.compile.log.slice(-1500)}`,
        );
      }
      expect(c.layoutErrors).toEqual([]);

      const text = pdfText(c.compile.pdf);
      if (text === null) throw new Error('pdftotext is not installed or failed');
      const first = text.indexOf('FIRSTCAP Figure 1');
      const second = text.indexOf('SECONDCAP Figure 2');
      expect(first).toBeGreaterThanOrEqual(0);
      expect(second).toBeGreaterThan(first);
      expect(c.bundle.files['main.tex']).not.toMatch(
        /\\(arabic|value|the|stepcounter|refstepcounter)\b/,
      );
    }, 300_000);
  },
);
