/**
 * EXP-051 criterion 4 (Node.js only, lane V-EXP-049-064, round 2): the converter's run of the math
 * gate gives the same verdict as the commit path's `mathGateReason` (the authority's injected gate,
 * room-host.ts), and the bundle manifest records the gate version that produced it, so two runs
 * can be compared for the same version. Nothing is compiled here.
 */
import { describe, expect, it } from 'vitest';
import { blockLines, doc, nid, run, type J } from '../test/docs.ts';
import { mathGateReason } from './math/gate.ts';
import { ALLOW_LIST } from './math/allow-list.ts';
import { computeAllowList } from './math/allow-list-source.ts';

const VALUES: Array<{ latex: string; accepted: boolean }> = [
  { latex: 'x^2', accepted: true },
  { latex: '\\frac{a}{b}', accepted: true },
  { latex: '\\begin{aligned}a&=b\\\\c&=d\\end{aligned}', accepted: true },
  { latex: '\\sum_{i=1}^{n} i', accepted: true },
  { latex: '\\def\\x{y}', accepted: false },
  { latex: '\\rlap{x}', accepted: false },
  { latex: '\\text{50% of}', accepted: false },
  { latex: '\\begin{align}a\\end{align}', accepted: false },
];

function displayEquation(latex: string, id: string): J {
  return { type: 'equation_block', attrs: { id, latex } };
}

describe('EXP-051 criterion 4: the export gate and the commit gate agree for one gate version', () => {
  it('records the allow-list version, KaTeX version and fingerprint in the manifest', async () => {
    const b = await run(doc([displayEquation('x^2', nid('e'))]));
    expect(b.manifest.mathGate).toEqual({
      version: ALLOW_LIST.version,
      katex: ALLOW_LIST.katex,
      fingerprint: ALLOW_LIST.fingerprint,
    });
    // The recorded fingerprint is the one the generator computes now (the allow-list is current).
    const fresh = await computeAllowList();
    expect(b.manifest.mathGate.fingerprint).toBe(fresh.fingerprint);
  });

  for (const v of VALUES) {
    it(`gives ${JSON.stringify(v.latex)} the verdict of the commit gate at export`, async () => {
      const commit = mathGateReason(v.latex, true);
      expect(commit === null).toBe(v.accepted);
      const id = nid('e');
      const b = await run(doc([displayEquation(v.latex, id)]));
      const lines = blockLines(b, id);
      if (v.accepted) {
        expect(lines.some((l) => l.includes('\\DEeq{'))).toBe(true);
        expect(b.diagnostics.some((d) => d.code === 'math_refused')).toBe(false);
      } else {
        expect(lines.some((l) => l.includes('\\DEeq{'))).toBe(false);
        expect(b.diagnostics.some((d) => d.code === 'math_refused')).toBe(true);
      }
    });
  }

  it('gives the same manifest and main.tex when the same document is converted again', async () => {
    const id = nid('e');
    const first = await run(doc([displayEquation('\\frac{a}{b}', id)]));
    const second = await run(doc([displayEquation('\\frac{a}{b}', id)]));
    expect(second.manifest).toEqual(first.manifest);
    expect(second.files['main.tex']).toBe(first.files['main.tex']);
  });
});
