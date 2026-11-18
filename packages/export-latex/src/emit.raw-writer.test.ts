/**
 * EXP-045 criterion 3 (search part, Node.js only): the raw writer `line` in `context.ts` takes only
 * `Tex`, and this test lists every module that calls it. The list is pinned: a new caller fails the
 * test until a reviewer adds it here. The callers are the converter's structural modules, which
 * build their TeX from `tex` templates, `t()` literals and the emitters. The criterion reads
 * "only the emitters make the `Tex` values it takes" (ADR 0143, items 4 and 11, default accepted by
 * the owner, 2026-11-17): the type rule and `emit.guard.test.ts` check that, and this list is the
 * guard on who calls it.
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

/** The modules that call `line(ctx, ...)`, as of this round (EXP-045, round 3). */
const KNOWN_CALLERS = ['blocks.ts', 'convert.ts', 'flow.ts', 'page.ts', 'tables.ts'];

describe('EXP-045 the raw writer `line` has a pinned list of callers (criterion 3, search part)', () => {
  it('is defined in context.ts and takes a Tex value', () => {
    const ctx = readFileSync(join(SRC, 'context.ts'), 'utf8');
    expect(ctx).toMatch(/export function line\(ctx: Ctx, value: Tex\): void/);
  });

  it('is called only from the pinned modules', () => {
    const callers = new Set<string>();
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file);
      if (rel === 'context.ts') continue;
      if (/\bline\(ctx\b/.test(readFileSync(file, 'utf8'))) callers.add(rel);
    }
    expect([...callers].sort()).toEqual([...KNOWN_CALLERS].sort());
  });
});
