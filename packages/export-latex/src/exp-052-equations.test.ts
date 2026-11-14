/**
 * EXP-052 criteria 1 to 4 (Node.js only): inline and display equations reach the bundle as gated
 * math, numbered the way the editor numbers them, with the environments of the story, and a `ref`
 * field to an equation label prints that number. Criterion 5 (the class clips every equation to its
 * box) is not met: the class does not clip (see the story Notes). Nothing is compiled here.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { blockLines, doc, nid, para, run, type J } from '../test/docs.ts';
import { mathGate } from './math/gate.ts';

const CLASS = readFileSync(fileURLToPath(new URL('../class/docedit.cls', import.meta.url)), 'utf8');
const LUA = '-- lua\n';

function display(id: string, latex: string, attrs: J = {}): J {
  return { type: 'equation_block', attrs: { id, latex, ...attrs } };
}

/** The `\DEeq` line of a display equation: `\DEeq{n}{anchor}{tag}{math}`, with the tag as group 1. */
function eqTag(lines: string[]): string | null {
  for (const l of lines) {
    const m = l.match(/\\DEeq\{\d+\}\{[^}]*\}\{([^}]*)\}\{/);
    if (m) return m[1]!;
  }
  return null;
}

describe('EXP-052 criterion 1: an inline equation is set as math in the line', () => {
  it('writes an inline equation with \\DEmath in its paragraph, and sets the OpenType math font in the styles', async () => {
    const pid = nid('p');
    const p = para('Energy ', { id: pid }, [
      { type: 'equation', attrs: { latex: 'E=mc^2' } },
      { type: 'text', text: ' holds.' },
    ]);
    const b = await run(doc([p]), { classFiles: { 'docedit.cls': CLASS, 'docedit.lua': LUA } });
    const lines = blockLines(b, pid).join('\n');
    expect(lines).toContain('\\DEmath{');
    expect(lines).toContain('E=mc^2');
    expect(lines).toContain('holds.');
    expect(b.files['styles.tex']).toMatch(/\\DEmathfont\{[0-9a-f9]{64}\.otf\}/);
  });
});

describe('EXP-052 criterion 2: numbered display equations carry their number, unnumbered ones do not', () => {
  it('prints the number of a numbered equation and no number for an unnumbered one', async () => {
    const numbered = nid('e');
    const plain = nid('e');
    const b = await run(
      doc([
        display(numbered, 'a+b', { numbered: true }),
        display(plain, 'c+d', { numbered: false }),
      ]),
      {
        classFiles: { 'docedit.cls': CLASS, 'docedit.lua': LUA },
      },
    );
    expect(eqTag(blockLines(b, numbered))).toBe('1');
    expect(eqTag(blockLines(b, plain))).toBe('');
    expect(blockLines(b, plain).some((l) => l.includes('\\DEeq{'))).toBe(true);
  });
});

describe('EXP-052 criterion 3: aligned, gathered, cases and matrix environments inside an equation are typeset', () => {
  const samples: Array<[string, string]> = [
    ['aligned', '\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}'],
    ['gathered', '\\begin{gathered} a = b \\\\ c = d \\end{gathered}'],
    ['cases', 'f(x) = \\begin{cases} 0 & x < 0 \\\\ 1 & x \\geq 0 \\end{cases}'],
    ['pmatrix', '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}'],
  ];
  for (const [name, latex] of samples) {
    it(`accepts the ${name} environment at the gate and writes it inside its \\DEeq line`, async () => {
      expect(mathGate(latex, true).ok).toBe(true);
      const id = nid('e');
      const b = await run(doc([display(id, latex)]), {
        classFiles: { 'docedit.cls': CLASS, 'docedit.lua': LUA },
      });
      const lines = blockLines(b, id).join('\n');
      expect(lines).toContain('\\DEeq{');
      expect(lines).toContain(`\\begin{${name}}`);
      expect(lines).toContain(`\\end{${name}}`);
    });
  }
});

describe('EXP-052 criterion 4: a ref field to an equation label prints the editor number', () => {
  it('prints the number of the labelled equation in the paragraph that refers to it', async () => {
    const eid = nid('e');
    const pid = nid('p');
    const b = await run(
      doc([
        display(eid, 'x^2', { numbered: true, label: 'pyth' }),
        para('See equation ', { id: pid }, [
          { type: 'field', attrs: { id: nid('f'), kind: 'ref', target: 'eq:pyth' } },
          { type: 'text', text: '.' },
        ]),
      ]),
    );
    const lines = blockLines(b, pid).join('\n');
    expect(lines).toContain('\\DEr{0}{See equation }');
    expect(lines).toMatch(/\\DEa\{\d+\}\{1\}/);
    expect(lines).toContain('\\DEr{');
  });
});
