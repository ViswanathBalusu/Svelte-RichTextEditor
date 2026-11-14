// What the package's sources must never contain (FRW-015, FRW-017, FRW-018; ADR 0012): no code
// evaluation of rule text, no user pattern handed to the runtime's regular-expression engine, and
// no binary floating point in decimal arithmetic.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = resolve(import.meta.dirname, '../src');
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? files(join(dir, e.name))
      : e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')
        ? [join(dir, e.name)]
        : [],
  );
const sources = files(src).map((file) => ({
  file: relative(src, file).replace(/\\/g, '/'),
  // Comments may name what the code avoids.
  code: readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, ''),
}));

describe('sources', () => {
  it('evaluate no rule text as code', () => {
    for (const { file, code } of sources) {
      expect(code, file).not.toMatch(/\beval\s*\(/);
      expect(code, file).not.toMatch(/\bnew\s+Function\b|\bFunction\s*\(/);
      expect(code, file).not.toMatch(/\bimport\s*\(/);
    }
  });

  it('build regular expressions only from the package constants, never from a rule', () => {
    const allowed = new Set(['FIELD_KEY_PATTERN', 'DEFINITION_ID_PATTERN', 'UUID7_PATTERN']);
    for (const { file, code } of sources)
      for (const m of code.matchAll(/new RegExp\(([^)]*)\)/g))
        expect(allowed.has(m[1]!.trim()), `${file}: ${m[0]}`).toBe(true);
    // The matcher itself has no regular expression at all.
    const pattern = sources.find((s) => s.file === 'pattern.ts')!.code;
    expect(pattern).not.toMatch(/RegExp|\.test\(|\.exec\(|\.match\(|\.replace\(/);
  });

  it('use no binary floating point for decimals', () => {
    for (const name of ['decimal.ts', 'evaluate.ts']) {
      const code = sources.find((s) => s.file === name)!.code;
      expect(code, name).not.toMatch(
        /parseFloat|toFixed|toPrecision|Number\(|Number\.parse|Math\.(round|floor|ceil|trunc)/,
      );
    }
  });

  it('use no Node.js or browser API (the type check refuses them too; FND-004)', () => {
    const strings = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
    for (const { file, code } of sources)
      expect(code.replace(strings, "''"), file).not.toMatch(
        /(?<![.\w])(process|window|document|Buffer|require|localStorage|navigator|fetch|XMLHttpRequest)\s*[.([]/,
      );
  });
});
