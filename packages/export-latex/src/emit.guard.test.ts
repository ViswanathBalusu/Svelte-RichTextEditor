/**
 * EXP-045 criterion 1 and 3 (search part): only `emit.ts` makes a `Tex` value. A module that casts a
 * string to `Tex`, or builds one with the module's private constructor, would let a user string
 * reach the bundle without an emitter. The type checker does the rest: a plain `string` is not
 * accepted where `Tex` is required. Node.js only.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('.', import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (name.endsWith('.ts') && !/\.test\.ts$/.test(name)) out.push(path);
  }
  return out;
}

/** Patterns that create a `Tex` value without an emitter. */
const FORGERY = [/\bas\s+Tex\b/, /\basTex\s*\(/, /\btexBrand\b/];

describe('EXP-045 only emit.ts makes TeX (criteria 1 and 3, search part)', () => {
  it('finds no cast to Tex and no use of the private constructor outside emit.ts', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (relative(SRC, file) === 'emit.ts') continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (FORGERY.some((p) => p.test(line))) offenders.push(`${relative(SRC, file)}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the constructor of emit.ts private to that module', () => {
    const emit = readFileSync(join(SRC, 'emit.ts'), 'utf8');
    expect(emit).toMatch(/const asTex = /);
    expect(/export\s+(?:const|function)\s+asTex\b/.test(emit)).toBe(false);
  });
});
