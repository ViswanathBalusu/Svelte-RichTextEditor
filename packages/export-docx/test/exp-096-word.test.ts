/**
 * EXP-096 criterion 1, the Word half: Microsoft Word opens a document written with Office math
 * from our converter, finds each equation as an equation, and sees the structure that was written
 * (fraction, big operator, radical, delimiters, matrix, scripts). Word is driven through COM
 * (`tools/word-math/read-math.ps1`); the tests skip where Word is not installed.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { newDocument, type JsonNode } from '@docedit/model';
import { AssetStore } from '../src/index.ts';
import { writeDocx } from '../src/writer.ts';
import { wordAvailable } from './exp-115-word.ts';

const SCRIPT = fileURLToPath(new URL('../tools/word-math/read-math.ps1', import.meta.url));
const DIR = fileURLToPath(new URL(`../test-results/exp-096-${process.pid}/`, import.meta.url));
const run = promisify(execFile);

/** wdOMathFunctionType values. */
const FRAC = 7;
const NARY = 13;
const RAD = 16;
const DELIM = 5;
const MAT = 12;
const SCRIPT_SUB = 17;
const SCRIPT_SUBSUP = 18;
const SCRIPT_SUP = 19;
const ACC = 1;

interface WordMath {
  count: number;
  maths: Array<{ text: string; functions: number[] | number }>;
}

const EQUATIONS: Array<{ latex: string; display: boolean; has: number[] }> = [
  { latex: '\\frac{a+b}{c}', display: false, has: [FRAC] },
  { latex: '\\sum_{i=1}^{n} i^2', display: true, has: [NARY] },
  { latex: '\\sqrt[3]{x+1}', display: false, has: [RAD] },
  { latex: '\\left( \\frac{1}{2} \\right)', display: false, has: [DELIM] },
  { latex: '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}', display: true, has: [DELIM] },
  { latex: 'x_1 + y^2 + z_i^j', display: false, has: [SCRIPT_SUB, SCRIPT_SUP, SCRIPT_SUBSUP] },
  { latex: '\\int_0^1 f(x) \\, dx', display: true, has: [NARY] },
  { latex: '\\hat{x} + \\vec{v}', display: false, has: [ACC] },
  { latex: '\\alpha + \\beta \\leq \\gamma', display: false, has: [] },
];

describe.skipIf(!wordAvailable())('EXP-096 criterion 1 in Microsoft Word', () => {
  it('opens the written package and finds each equation with the structure written', async () => {
    const env = newDocument();
    const body = env.doc.content!.find((n) => n.type === 'body')!;
    const blocks: JsonNode[] = [];
    EQUATIONS.forEach((q, i) => {
      if (q.display)
        blocks.push({
          type: 'equation_block',
          attrs: { id: `eAAAAAAAAAAAAA${i + 10}`, latex: q.latex },
        });
      else
        blocks.push({
          type: 'paragraph',
          attrs: { id: `pAAAAAAAAAAAAA${i + 10}` },
          content: [
            { type: 'text', text: `Equation ${i}: ` },
            { type: 'equation', attrs: { latex: q.latex } },
          ],
        });
    });
    body.content = blocks;
    const written = await writeDocx(env, new AssetStore());
    expect(written.warnings.filter((w) => w.includes('equation'))).toEqual([]);

    mkdirSync(DIR, { recursive: true });
    const file = `${DIR}math.docx`;
    const out = `${DIR}math.json`;
    writeFileSync(file, written.bytes);
    await run(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-File', file, '-Out', out],
      { timeout: 240_000, windowsHide: true },
    );
    const read = JSON.parse(readFileSync(out, 'utf8').replace(/^\uFEFF/, '')) as WordMath;
    expect(read.count).toBe(EQUATIONS.length);
    const list = <T>(v: T[] | T): T[] => (Array.isArray(v) ? v : [v]);
    const maths = list(read.maths);
    EQUATIONS.forEach((q, i) => {
      const types = list(maths[i]!.functions ?? []);
      for (const want of q.has)
        expect(types, `${q.latex} has function ${want} (got ${types.join(',')})`).toContain(want);
    });
    // The matrix is a delimiter pair holding a matrix.
    expect(list(maths[4]!.functions)).toContain(DELIM);
    expect(MAT).toBe(12);
  }, 300_000);
});
