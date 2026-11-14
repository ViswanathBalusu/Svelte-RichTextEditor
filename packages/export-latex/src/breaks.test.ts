/**
 * Break emission (Node.js only): the converter writes the class macro for each `break` kind inside
 * the paragraph that holds it (EXP-031). The tests read main.tex of the converter's bundle. They do
 * not show where the PDF breaks: that is the class macros' work and needs a LaTeX run, which these
 * tests do not do, so no EXP-031 criterion is ticked.
 */
import { describe, expect, it } from 'vitest';
import { blockLines, doc, nid, para, run, type J } from '../test/docs.ts';

const idOfPara = (p: J): string => (p['attrs'] as J)['id'] as string;

/** A paragraph of the text `A`, a break of the given kind, then the text `B`. */
function withBreak(kind: string): J {
  return para('', {}, [
    { type: 'text', text: 'A' },
    { type: 'break', attrs: { id: nid('br'), kind } },
    { type: 'text', text: 'B' },
  ]);
}

describe('EXP-031 break emission (converter side)', () => {
  it('writes a line break as \\DEbr inside the same paragraph, between the two runs', async () => {
    const p = withBreak('line');
    const b = await run(doc([p]));
    const lines = blockLines(b, idOfPara(p)).join('\n');
    expect(lines).toContain('\\DEbr}');
    expect(lines).not.toMatch(/\\DEbrpage|\\DEbrcol/);
    expect(lines.indexOf('\\DEbr')).toBeGreaterThan(lines.indexOf('\\DEa{'));
  });

  it('writes a page break as \\DEbrpage, and a column break as \\DEbrcol', async () => {
    const page = withBreak('page');
    const column = withBreak('column');
    const b = await run(doc([page, column]));
    expect(blockLines(b, idOfPara(page)).join('\n')).toContain('\\DEbrpage');
    expect(blockLines(b, idOfPara(column)).join('\n')).toContain('\\DEbrcol');
  });
});
