/**
 * Paragraph spacing and line spacing (Node.js only): EXP-021 criteria 1 to 4. The gaps are read
 * from main.tex (`\DEgap`), the line rules from `\DElsm`, `\DElse` and `\DElsa`, and the per-line
 * application from the house class's Lua source. Criterion 5 (the shared fixtures of EXP-115) is
 * not covered here. Nothing compiles: the gaps in the PDF are not measured.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { blockLines, doc, para, run, type J } from '../test/docs.ts';
import { dimen } from './emit.ts';

const LUA = readFileSync(fileURLToPath(new URL('../class/docedit.lua', import.meta.url)), 'utf8');
const CLS = readFileSync(fileURLToPath(new URL('../class/docedit.cls', import.meta.url)), 'utf8');
const MAIN = 'main.tex';
const RANGE = { min: 0, max: 31680 };
const idOf = (p: J): string => (p['attrs'] as J)['id'] as string;

/** The arguments of every `\DEgap{...}` in main.tex, in order. */
const gapsOf = (main: string): string[] =>
  [...main.matchAll(/\\DEgap\{([^}]*)\}/g)].map((m) => m[1]!);

/** A paragraph style with the given direct properties. */
const style = (id: string, attrs: J): J => ({
  type: 'style_def',
  attrs: { id, kind: 'paragraph', name: id, ...attrs },
});

describe('EXP-021 criterion 1: the gap between two paragraphs is the larger of the first spaceAfter and the second spaceBefore', () => {
  it('writes \\DEgap with the larger value, for any pair of spacings', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 2000 }),
        fc.integer({ min: 0, max: 2000 }),
        async (after, before) => {
          const a = para('first', { spaceBefore: 0, spaceAfter: after });
          const b = para('second', { spaceBefore: before, spaceAfter: 0 });
          const bundle = await run(doc([a, b]));
          const expected = Math.max(after, before);
          const gaps = gapsOf(bundle.files[MAIN]!);
          if (expected === 0) expect(gaps).toEqual([]);
          else expect(gaps).toEqual([String(dimen(expected, RANGE))]);
        },
      ),
      { numRuns: 40 },
    );
  });
});

describe('EXP-021 criterion 2: contextualSpacing removes the gap between paragraphs of the same style', () => {
  it('writes no gap between two paragraphs of a style with contextualSpacing', async () => {
    const styles = [style('Tight', { spaceBefore: 240, spaceAfter: 240, contextualSpacing: true })];
    const bundle = await run(
      doc([para('one', { style: 'Tight' }), para('two', { style: 'Tight' })], { styles }),
    );
    expect(gapsOf(bundle.files[MAIN]!).filter((g) => g !== String(dimen(0, RANGE)))).toEqual([]);
  });

  it('keeps the gap when the two paragraphs have different styles (control)', async () => {
    const styles = [
      style('Tight', { spaceBefore: 240, spaceAfter: 240, contextualSpacing: true }),
      style('Plain', { spaceBefore: 240, spaceAfter: 240 }),
    ];
    const bundle = await run(
      doc([para('one', { style: 'Tight' }), para('two', { style: 'Plain' })], { styles }),
    );
    expect(gapsOf(bundle.files[MAIN]!)).toContain(String(dimen(240, RANGE)));
  });
});

describe('EXP-021 criterion 3: multiple line spacing is applied per line in post_linebreak_filter, not as a baselineskip', () => {
  it('writes the thousandths of a multiple rule as \\DElsm and never sets \\baselineskip in the paragraph', async () => {
    const p = para('spaced', { lineRule: 'multiple', lineSpacing: 1150 });
    const bundle = await run(doc([p]));
    expect(blockLines(bundle, idOf(p)).join('\n')).toContain('\\DElsm{1150}');
    expect(bundle.files[MAIN]!).not.toMatch(/\\baselineskip\s*=/);
  });

  it('applies the rule in a post_linebreak_filter callback that reads the rule per line (class audit)', () => {
    expect(LUA).toMatch(/add_to_callback\("post_linebreak_filter",\s*lines,\s*"docedit\.lines"\)/);
    expect(LUA).toMatch(/lsr/);
    expect(CLS).toMatch(/\\newcommand\*\\DElsm\[1\]\{\\DE@lsrule=0 \\DE@lsval=#1\\relax\}/);
  });
});

describe('EXP-021 criterion 4: exact and at-least line spacing are lengths', () => {
  it('writes an exact or at-least value as the length the class reads, clamped to its range', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 31680 }),
        fc.constantFrom('exact', 'atLeast'),
        async (v, rule) => {
          const p = para('fixed', { lineRule: rule, lineSpacing: v });
          const bundle = await run(doc([p]));
          const macro = rule === 'exact' ? '\\DElse' : '\\DElsa';
          expect(blockLines(bundle, idOf(p)).join('\n')).toContain(`${macro}{${v}}`);
        },
      ),
      { numRuns: 30 },
    );
  });
});
