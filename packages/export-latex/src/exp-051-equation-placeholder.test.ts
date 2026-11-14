/**
 * EXP-051 criterion 3 (Node.js only): an equation that fails the gate when the converter runs
 * (for example after the allow-list was narrowed) is replaced in the bundle by a visible placeholder,
 * a diagnostic with its block identifier is returned, and the rest of the document is converted.
 * Nothing is compiled here: the tests read main.tex, map.json and the diagnostics of the bundle.
 */
import { describe, expect, it } from 'vitest';
import { blockLines, doc, nid, para, run, type J } from '../test/docs.ts';

/** Refused by the gate: a forbidden primitive (09 §6.1). */
const REFUSED = '\\def\\x{1}';
/** Refused by the gate: a painting command (EXP-050). */
const PAINTS = '\\rlap{x}';

function displayEquation(latex: string, id: string): J {
  return { type: 'equation_block', attrs: { id, latex } };
}

describe('EXP-051 criterion 3: a refused equation is replaced by a placeholder and the rest exports', () => {
  it('replaces a refused display equation with a placeholder, reports it with its block, and keeps the paragraphs around it', async () => {
    const eid = nid('e');
    const before = para('Before the equation.');
    const after = para('After the equation.');
    const b = await run(doc([before, displayEquation(REFUSED, eid), after]));

    const found = b.diagnostics.filter((d) => d.code === 'math_refused');
    expect(found.map((d) => d.blockId)).toEqual([eid]);
    expect(found[0]!.severity).toBe('warning');

    const main = b.files['main.tex']!;
    expect(main).not.toContain('\\def\\x{1}');
    expect(blockLines(b, eid).some((l) => l.includes('\\DEplaceholder{'))).toBe(true);
    expect(blockLines(b, eid).some((l) => l.includes('\\DEeq{'))).toBe(false);
    expect(blockLines(b, (before.attrs as J)['id'] as string).join('\n')).toContain(
      'Before the equation.',
    );
    expect(blockLines(b, (after.attrs as J)['id'] as string).join('\n')).toContain(
      'After the equation.',
    );
    expect(b.diagnostics.some((d) => d.severity === 'error')).toBe(false);
  });

  it('replaces a refused inline equation with a placeholder inside its paragraph, reported with the paragraph', async () => {
    const pid = nid('p');
    const p = para('Price ', { id: pid }, [
      { type: 'equation', attrs: { latex: PAINTS } },
      { type: 'text', text: ' is listed.' },
    ]);
    const b = await run(doc([p]));
    expect(b.diagnostics.filter((d) => d.code === 'math_refused').map((d) => d.blockId)).toEqual([
      pid,
    ]);
    expect(b.files['main.tex']).not.toContain('\\rlap');
    const text = blockLines(b, pid).join('\n');
    expect(text).toContain('Price');
    expect(text).toContain('is listed.');
    expect(text).toContain('\\DEph{');
  });

  it('keeps every other equation of the document when one is replaced', async () => {
    const good = nid('e');
    const bad = nid('e');
    const b = await run(
      doc([
        displayEquation('x^2', good),
        displayEquation(REFUSED, bad),
        displayEquation('y^2', nid('e')),
      ]),
    );
    expect(b.diagnostics.filter((d) => d.code === 'math_refused').map((d) => d.blockId)).toEqual([
      bad,
    ]);
    expect(blockLines(b, good).some((l) => l.includes('\\DEeq{'))).toBe(true);
    expect(b.files['main.tex']).toContain('x^2');
    expect(b.files['main.tex']).toContain('y^2');
  });
});
