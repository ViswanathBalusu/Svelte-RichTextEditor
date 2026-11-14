/**
 * EXP-051 criterion 4 (Node.js only): when the converter runs the gate again, an equation the gate
 * accepts at commit time is written as an equation, and a second conversion of the same document
 * gives the same bytes. Nothing is compiled here: the tests read main.tex and the diagnostics.
 */
import { describe, expect, it } from 'vitest';
import { blockLines, doc, nid, run, type J } from '../test/docs.ts';
import { mathGate } from './math/gate.ts';

/** Values the gate accepts (display form), each covered by its own assertion below. */
const ACCEPTED = [
  'x^2',
  '\\frac{a}{b}',
  '\\begin{aligned}a&=b\\\\c&=d\\end{aligned}',
  '\\sum_{i=1}^{n} i',
];

function displayEquation(latex: string, id: string): J {
  return { type: 'equation_block', attrs: { id, latex } };
}

describe('EXP-051 criterion 4: the converter gives an accepted equation the same result as the commit gate', () => {
  for (const latex of ACCEPTED) {
    it(`accepts ${JSON.stringify(latex)} at commit time and writes it as an equation at export`, async () => {
      expect(mathGate(latex, true)).toEqual({ ok: true });
      const id = nid('e');
      const b = await run(doc([displayEquation(latex, id)]));
      expect(b.diagnostics.some((d) => d.code === 'math_refused')).toBe(false);
      expect(blockLines(b, id).some((l) => l.includes('\\DEeq{'))).toBe(true);
      expect(b.files['main.tex']).not.toContain('\\DEplaceholder{');
    });
  }

  it('gives the same main.tex and map.json for the same document converted twice', async () => {
    const first = nid('e');
    const second = nid('e');
    const make = () =>
      doc([displayEquation(ACCEPTED[0]!, first), displayEquation(ACCEPTED[2]!, second)]);
    const a = await run(make());
    const b = await run(make());
    expect(b.files['main.tex']).toBe(a.files['main.tex']);
    expect(b.diagnostics).toEqual(a.diagnostics);
  });
});
