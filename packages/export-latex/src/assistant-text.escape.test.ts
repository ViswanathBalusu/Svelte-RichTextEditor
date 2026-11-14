/**
 * The export's half of UX-048 criterion 5 (Node.js only): text an assistant wrote, kept as one
 * literal text segment by the shell's output guard (packages/ui/src/assistant/output-guard.ts), is
 * stored as the plain text of a paragraph. Through the converter it reaches main.tex as ordinary
 * escaped text: the emitter's own escapes, no control sequence, no maths, and no other block.
 *
 * The shell's insertion of that text (UX-045, UX-046) is not built, so this test builds the
 * paragraph itself. The strings are those of the shell's injection test and known attacks.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { blockLines, doc, para, run } from '../test/docs.ts';
import { clean, text } from './emit.ts';

/** LaTeX control sequences and maths delimiters an assistant might write. */
const OUTPUTS: readonly string[] = [
  'Use $\\frac{a}{b}$, \\section{Intro}, \\(x^2\\) and \\input{file}.',
  '\\input{/etc/passwd}',
  '\\immediate\\write18{id}',
  '$$x$$ and \\[ y \\]',
  '\\begin{verbatim}\\end{verbatim}',
  '}\\end{document}',
  '^^5c^^5cwrite18',
  '\\catcode`\\@=11 \\makeatletter',
  '\\href{https://example.invalid}{click} \\url{javascript:alert(1)}',
  '\\includegraphics{/etc/hosts} % comment # & ~ _',
];

/** The escapes the text emitter writes, read back (as in emit.fuzz.test.ts), and its spaces. */
const ESCAPED: Readonly<Record<string, string>> = {
  '\\textbackslash{}': '\\',
  '\\textasciicircum{}': '^',
  '\\textasciitilde{}': '~',
  '{[}': '[',
  '{]}': ']',
  '\\{': '{',
  '\\}': '}',
  '\\$': '$',
  '\\&': '&',
  '\\#': '#',
  '\\_': '_',
  '\\%': '%',
  '\\ ': ' ',
  '~': '\u00a0',
};
const TOKEN =
  /\\textbackslash\{\}|\\textasciicircum\{\}|\\textasciitilde\{\}|\{\[\}|\{\]\}|\\[{}$&#_%\- ]|~|[\s\S]/g;

/** Backslashes that are not part of one of the emitter's escapes: control sequences. */
function controlSequences(tex: string): string[] {
  return [...tex.matchAll(TOKEN)].map((m) => m[0]).filter((t) => t === '\\');
}

/** Reads the escapes back; the result is what the reader sees. */
function readBack(tex: string): string {
  let back = '';
  for (const m of tex.matchAll(TOKEN)) back += ESCAPED[m[0]] ?? m[0];
  return back;
}

/** The paragraph's text runs in main.tex: the argument of each `\DEr{<n>}{...}%` line. */
const RUN_LINE = /^\\DEr\{\d+\}\{(.*)\}%$/;

interface Exported {
  lines: string[];
  runs: string;
  others: string[];
}

async function exported(value: string): Promise<Exported> {
  const p = para(value);
  const id = (p['attrs'] as { id: string }).id;
  const bundle = await run(doc([p]));
  const lines = blockLines(bundle, id);
  const runs = lines.flatMap((l) => RUN_LINE.exec(l)?.[1] ?? []).join('');
  // Block ids other than the paragraph's (the map's null entries are the document's frame).
  const others = bundle.map.blocks.filter((b): b is string => typeof b === 'string' && b !== id);
  return { lines, runs, others };
}

function check(value: string, { lines, runs, others }: Exported): void {
  // The paragraph is one block whose text runs read back to the literal string.
  expect(others, value).toEqual([]);
  expect(readBack(runs), value).toBe(clean(value));
  // No control sequence of its own: every backslash in the runs is one of the emitter's escapes.
  expect(controlSequences(runs), value).toEqual([]);
  // Nothing the string names became a command or maths in the paragraph's lines.
  expect(lines.join('\n'), value).not.toMatch(
    /\\(input|write18|immediate|section|frac|begin|end|href|url|includegraphics|catcode|makeatletter)\b/,
  );
  expect(lines.join('\n'), value).not.toMatch(/(^|[^\\])\$/);
}

describe('assistant text in the LaTeX export (UX-048 criterion 5, export side)', () => {
  it('reaches main.tex as escaped text that reads back to the literal string', async () => {
    for (const value of OUTPUTS) {
      const out = await exported(value);
      check(value, out);
      // It is what the text emitter writes for the string, not anything the converter builds.
      expect(out.runs, value).toBe(String(text(value)));
    }
  });

  it('holds for any string mixing LaTeX specials and words', async () => {
    const piece = fc.constantFrom(
      ...['\\', '{', '}', '$', '&', '#', '_', '%', '^', '~', '[', ']', '(', ')'],
      ...['input', 'frac', 'x', ' ', '\u00e9', '\u05e9'],
    );
    await fc.assert(
      fc.asyncProperty(
        fc.array(piece, { minLength: 1, maxLength: 24 }).map((a) => a.join('')),
        async (value) => check(value, await exported(value)),
      ),
      { numRuns: 200 },
    );
  });
});
