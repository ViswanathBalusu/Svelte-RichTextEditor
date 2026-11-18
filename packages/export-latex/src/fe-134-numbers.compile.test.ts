/**
 * FE-134 criterion 3, the PDF side (Node.js only, sandbox): caption numbers and the text of a
 * `ref` field in the compiled PDF follow the content, whatever the fields' `cached` text says. The
 * document is the one the editor's test draws (packages/engine/src/view/fe-134-computed-field.
 * universal.test.ts): figure A, then figure B with a reference to it, every `cached` text still `1`.
 * The editor shows A as 1 and B and its reference as 2; this test reads the PDF's text and finds the
 * same numbers. Both read the model's `computeLabels` (CDM-042); the export computes them again and
 * never trusts `cached`.
 *
 * The test skips when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import { describe, expect, it } from 'vitest';
import { doc, para, type J } from '../test/docs.ts';
import { convertAndCompile, keep, pdfText, sandboxReady } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const FIG_A = 'figA000000000001';
const FIG_B = 'figB000000000001';

const figure = (id: string, alt: string): J => ({
  type: 'figure',
  attrs: { id, width: 2880, height: 1440, alt, align: null, placement: 'here' },
  content: [
    {
      type: 'caption',
      attrs: { id: null },
      content: [
        { type: 'text', text: 'Figure ' },
        { type: 'field', attrs: { kind: 'seq', name: 'Figure', cached: '1' } },
      ],
    },
  ],
});

describe.skipIf(!ready)(
  'FE-134 criterion 3: caption numbers and references in the PDF follow the content',
  () => {
    it('prints Figure 1, Figure 2 and a reference to figure 2 although every cached text is 1', async () => {
      const c = await convertAndCompile(
        doc([
          figure(FIG_A, 'PICA'),
          figure(FIG_B, 'PICB'),
          {
            type: 'paragraph',
            attrs: { id: 'pRefxxxxxxxxxxx' },
            content: [
              { type: 'text', text: 'See ' },
              {
                type: 'field',
                attrs: { kind: 'ref', target: `node:${FIG_B}`, format: null, cached: '1' },
              },
              { type: 'text', text: ' above.' },
            ],
          },
          para('END'),
        ]),
        {
          profile: 'preview',
          title: 'fe-134-numbers',
          instant: '2026-11-06T10:00:00.000Z',
          timeZone: 'Europe/London',
          suggestions: 'accept',
        } as never,
      );
      if (!c.compile.ok || !c.compile.pdf)
        throw new Error(
          `the compile failed (${keep('fe-134-numbers', c)}):\n${c.compile.log.slice(-1500)}`,
        );
      const text = pdfText(c.compile.pdf);
      if (text === null) throw new Error('pdftotext is not installed or failed');
      const flat = text.replace(/\s+/g, ' ');
      expect(flat.match(/Figure 1/g)?.length).toBe(1);
      expect(flat.match(/Figure 2/g)?.length).toBe(1);
      expect(flat).toContain('See 2 above.');
      expect(flat).not.toContain('See 1');
    }, 180_000);
  },
);
