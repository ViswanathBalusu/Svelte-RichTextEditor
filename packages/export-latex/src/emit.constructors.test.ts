/**
 * EXP-045 criterion 1 (the CI check, Node.js only): the ways to make TeX are the eight emitters, a
 * fixed list of their forms and of the composition helpers, and the two checked constructors
 * `fontFile` and `gatedMath`. Three checks together make a new route fail the build:
 * - the type checker refuses a plain `string` where `Tex` is required, and `emit.guard.test.ts`
 *   refuses a cast to `Tex`, so a module cannot make TeX itself;
 * - this test lists every export of `emit.ts` that makes or returns `Tex`, and fails when one is
 *   added or removed without a line here, so a new constructor needs a reviewer's edit to this list
 *   (the review of criterion 4 then asks which emitter covers the new context);
 * - this test pins where the two checked constructors are called, and that math is written only
 *   after the gate has passed it (ADR 0115, item 10; the gate is a sanctioned path, not a ninth
 *   emitter).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EMITTERS } from './emit.ts';

const SRC = fileURLToPath(new URL('.', import.meta.url));
const read = (name: string): string => readFileSync(join(SRC, name), 'utf8');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (name.endsWith('.ts') && !/\.test\.ts$/.test(name)) out.push(path);
  }
  return out;
}

/** The functions and constants of `emit.ts` that make `Tex` or return it. */
function texExports(): string[] {
  const chunks = read('emit.ts')
    .split(/^(?=export )/m)
    .filter((c) => c.startsWith('export '));
  const names: string[] = [];
  for (const chunk of chunks) {
    const m = /^export (?:function|const) (\w+)/.exec(chunk);
    if (!m) continue;
    const head = chunk.split('\n')[0] ?? '';
    if (chunk.includes('asTex(') || /\bTex\b/.test(head)) names.push(m[1]!);
  }
  return names.sort();
}

/** The eight emitters of 09 §4. */
const EIGHT = [
  'text',
  'pdfString',
  'kvValue',
  'url',
  'dimen',
  'color',
  'enumLookup',
  'generatedId',
] as const;

/** Forms of an emitter: the same rule, for another place the value goes. */
const FORMS = [
  'textChunks', // text, with the offsets the layout report needs
  'pdfHexString', // pdfString, for a PDF hex string in the class's Lua code
  'int', // generatedId
  'letters', // generatedId
  'assetFile', // generatedId: a name from a content hash
];

/** Composition of values that are already `Tex`: nothing user-controlled enters here. */
const COMPOSITION = ['tex', 'lit', 'join', 'markedLines', 'EMPTY'];

/** Checked constructors outside the eight (ADR 0115, item 10). */
const CHECKED = ['fontFile', 'gatedMath'];

describe('EXP-045 criterion 1: the constructors of TeX are a fixed, reviewed list', () => {
  it('names the eight emitters of 09 §4, and each is an export of emit.ts', () => {
    expect([...EMITTERS].sort()).toEqual([...EIGHT].sort());
    const exported = texExports();
    for (const name of EIGHT) expect(exported, name).toContain(name);
  });

  it('has no export that makes or returns Tex beyond the emitters, their forms, the composition helpers and the two checked constructors', () => {
    const expected = [...EIGHT, ...FORMS, ...COMPOSITION, ...CHECKED].sort();
    expect(texExports()).toEqual(expected);
  });

  it('calls fontFile only from convert.ts, with names from the font manifest', () => {
    const callers = new Set<string>();
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file);
      if (rel === 'emit.ts') continue;
      if (/\bfontFile\(/.test(readFileSync(file, 'utf8'))) callers.add(rel);
    }
    expect([...callers]).toEqual(['convert.ts']);
    // `fontFile` itself accepts a content hash and a font extension only.
    expect(read('emit.ts')).toMatch(/\^\[0-9a-f\]\{64\}\\\.\(\?:ttf\|otf\|ttc\|otc\)\$/);
  });

  it('calls gatedMath only from blocks.ts and inline.ts, each time after the gate has passed the math', () => {
    const calls: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file);
      if (rel === 'emit.ts') continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!/\bgatedMath\(/.test(line)) return;
        calls.push(rel);
        // The call stands on a line of an `if (gate.ok)`, or in the block after one.
        const window = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
        expect(window, `${rel}:${i + 1}`).toMatch(/\bgate\.ok\b/);
      });
    }
    expect(calls.sort()).toEqual(['blocks.ts', 'inline.ts']);
  });

  it('writes the gate result as a literal `true` argument, so a value cannot stand in for the gate', () => {
    expect(read('emit.ts')).toMatch(
      /export function gatedMath\(latex: string, passed: true\): Tex/,
    );
  });
});
