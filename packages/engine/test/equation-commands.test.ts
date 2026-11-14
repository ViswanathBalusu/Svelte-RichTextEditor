/**
 * Equation commands (FE-070 criteria 2 and 3). Criterion 1 (the chunk of the math editor), 4 (the
 * authority's rejection of an equation), 5 (the strict policy), 6 (keyboard use) and 7 (the
 * read-only open) are the element's and are not tested here.
 */
import fc from 'fast-check';
import type { Node } from 'prosemirror-model';
import { EditorState, type Transaction } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import {
  LATEX_MAX_CODE_POINTS,
  MATH_NESTING_MAX,
  latexLength,
  latexNesting,
  latexRefusal,
  setEquationLatex,
} from '../src/equation-commands.ts';
import { editingSchema } from '../src/schema.ts';

const BLOCK_ID = 'eqAuthBlock000001';
const PARA_ID = 'pAuthEq00000001';

/** A body with one paragraph holding an inline equation, and one display equation. */
function equationState(inline = 'x^2', block = 'a=b'): EditorState {
  const schema = editingSchema();
  const envelope = {
    type: 'doc',
    content: [
      {
        type: 'defs',
        content: [
          { type: 'settings', attrs: { lang: 'en-GB', defaultParagraphStyle: 'Normal' } },
          {
            type: 'style_def',
            attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal', builtIn: true },
          },
          { type: 'page_setup', attrs: { id: 'ps1' } },
        ],
      },
      {
        type: 'body',
        attrs: { pageSetup: 'ps1' },
        content: [
          {
            type: 'paragraph',
            attrs: { id: PARA_ID, style: null },
            content: [
              { type: 'text', text: 'Before ' },
              { type: 'equation', attrs: { latex: inline } },
            ],
          },
          { type: 'equation_block', attrs: { id: BLOCK_ID, latex: block } },
        ],
      },
    ],
  };
  return EditorState.create({ doc: schema.nodeFromJSON(envelope) });
}

/** The position of the first node of the given type, and the node. */
function find(state: EditorState, name: string): { pos: number; node: Node } {
  let found: { pos: number; node: Node } | null = null;
  state.doc.descendants((node, pos) => {
    if (!found && node.type.name === name) found = { pos, node };
    return found === null;
  });
  if (!found) throw new Error(`no ${name}`);
  return found;
}

const always = () => true;

/** Runs the command and returns the dispatched transactions and the result. */
function run(state: EditorState, pos: number, latex: string, writable = always) {
  const transactions: Transaction[] = [];
  const result = setEquationLatex(state, pos, latex, { writable }, (tr) => transactions.push(tr));
  return { result, transactions };
}

describe('setting the source of an equation (FE-070 criterion 2)', () => {
  it('sets the source of an inline equation in one transaction with one step', () => {
    const state = equationState();
    const { pos } = find(state, 'equation');
    const { result, transactions } = run(state, pos, '\\frac{a}{b}');
    expect(result).toEqual({ ok: true, pos });
    expect(transactions).toHaveLength(1);
    expect(transactions[0]!.steps).toHaveLength(1);
    const next = state.apply(transactions[0]!);
    expect(find(next, 'equation').node.attrs['latex']).toBe('\\frac{a}{b}');
    // The paragraph text and the display equation are unchanged.
    expect(next.doc.textContent).toContain('Before ');
    expect(find(next, 'equation_block').node.attrs['latex']).toBe('a=b');
  });

  it('sets the source of a display equation and keeps its identifier', () => {
    const state = equationState();
    const { pos } = find(state, 'equation_block');
    const { result, transactions } = run(state, pos, '\\sum_{i=1}^{n} i');
    expect(result.ok).toBe(true);
    expect(transactions).toHaveLength(1);
    const block = find(state.apply(transactions[0]!), 'equation_block').node;
    expect(block.attrs['latex']).toBe('\\sum_{i=1}^{n} i');
    expect(block.attrs['id']).toBe(BLOCK_ID);
  });

  it('checks without dispatching when no dispatch is given', () => {
    const state = equationState();
    const { pos } = find(state, 'equation');
    expect(setEquationLatex(state, pos, 'y', { writable: always })).toEqual({ ok: true, pos });
    expect(find(state, 'equation').node.attrs['latex']).toBe('x^2');
  });
});

describe('the limits on the source (FE-070 criterion 3, I7 and the math nesting limit)', () => {
  it('accepts 4,000 code points and refuses 4,001 without dispatching', () => {
    const state = equationState();
    const { pos } = find(state, 'equation');
    const ok = run(state, pos, 'x'.repeat(LATEX_MAX_CODE_POINTS));
    expect(ok.result.ok).toBe(true);
    const tooLong = run(state, pos, 'x'.repeat(LATEX_MAX_CODE_POINTS + 1));
    expect(tooLong.result).toEqual({ ok: false, reason: 'too-long' });
    expect(tooLong.transactions).toHaveLength(0);
  });

  it('counts code points, not UTF-16 units (a non-BMP letter is one character)', () => {
    const letter = '\u{1D465}'; // mathematical italic small x, two UTF-16 units
    expect(latexLength(letter.repeat(LATEX_MAX_CODE_POINTS))).toBe(LATEX_MAX_CODE_POINTS);
    expect(latexRefusal(letter.repeat(LATEX_MAX_CODE_POINTS))).toBeNull();
    expect(latexRefusal(letter.repeat(LATEX_MAX_CODE_POINTS + 1))).toBe('too-long');
  });

  it('accepts 50 nested braces and refuses 51 without dispatching', () => {
    const state = equationState();
    const { pos } = find(state, 'equation');
    const fifty = '{'.repeat(MATH_NESTING_MAX) + '}'.repeat(MATH_NESTING_MAX);
    expect(run(state, pos, fifty).result.ok).toBe(true);
    const fiftyOne = '{'.repeat(MATH_NESTING_MAX + 1) + '}'.repeat(MATH_NESTING_MAX + 1);
    const refused = run(state, pos, fiftyOne);
    expect(refused.result).toEqual({ ok: false, reason: 'too-deep' });
    expect(refused.transactions).toHaveLength(0);
  });

  it('does not count escaped braces as nesting', () => {
    expect(latexNesting('\\{'.repeat(120))).toBe(0);
    expect(latexNesting('\\\\{{x}}')).toBe(2);
    expect(latexNesting('{a}{b}')).toBe(1);
  });

  it('property: the nesting of k nested groups is k, and a source of k is accepted only up to 50', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 80 }), (k) => {
        const latex = '{'.repeat(k) + 'x' + '}'.repeat(k);
        expect(latexNesting(latex)).toBe(k);
        expect(latexRefusal(latex)).toBe(k > MATH_NESTING_MAX ? 'too-deep' : null);
      }),
    );
  });

  it('property: a source is refused as too long exactly when it has more than 4,000 code points', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4100 }), (n) => {
        const latex = 'a'.repeat(n);
        expect(latexRefusal(latex)).toBe(n > LATEX_MAX_CODE_POINTS ? 'too-long' : null);
      }),
      { numRuns: 60 },
    );
  });
});

describe('refusals that change nothing (FE-070 criterion 7, in the engine)', () => {
  it('refuses a position that is not an equation', () => {
    const state = equationState();
    const para = find(state, 'paragraph').pos;
    const { result, transactions } = run(state, para, 'x');
    expect(result).toEqual({ ok: false, reason: 'not-equation' });
    expect(transactions).toHaveLength(0);
  });

  it('refuses a write in a position the user cannot change and leaves the document unchanged', () => {
    const state = equationState();
    const { pos } = find(state, 'equation_block');
    const before = state.doc;
    const { result, transactions } = run(state, pos, 'z', () => false);
    expect(result).toEqual({ ok: false, reason: 'read-only' });
    expect(transactions).toHaveLength(0);
    expect(state.doc).toBe(before);
  });

  it('checks the limits before the scope, so a refused source names its limit', () => {
    const state = equationState();
    const { pos } = find(state, 'equation');
    const result = setEquationLatex(state, pos, 'x'.repeat(4001), { writable: () => false });
    expect(result).toEqual({ ok: false, reason: 'too-long' });
  });
});
