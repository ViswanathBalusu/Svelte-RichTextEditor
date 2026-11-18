// One visibility gate (HIS-024 criterion 1): no route or module of the services outside the gate
// modules computes `minVisibleSeq` or `editsSomewhere` itself, and `visibleFrom` (the copy the
// control plane once held) is gone. The walk reads the service sources, so a new copy fails the build.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));
/** The modules that own the rule: the control-plane and data-plane gates. */
const GATE_MODULES = new Set(['control-plane/gate.ts', 'data-plane/gate.ts']);
/**
 * The rule's own calls, which only the gate modules may make. A call through a receiver (`room.minVisibleSeq(`)
 * delegates to the room and is not a copy, so it is not matched; nor is a method definition.
 */
const RULE_CALLS = [
  /(^|[^.\w])minVisibleSeq\s*\(/,
  /(^|[^.\w])editsSomewhere\s*\(/,
  /\bvisibleFrom\b/,
];
const METHOD_DEFINITION = /^\s*\w+\(.*\)\s*:\s*number\s*\{\s*$/;

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

describe('one visibility gate (HIS-024 criterion 1)', () => {
  const files = sources(SRC).map((p) => ({ rel: relative(SRC, p).split('\\').join('/'), path: p }));

  it('walks the control and data planes, and finds the gate modules among them', () => {
    expect(files.length).toBeGreaterThan(20);
    for (const m of GATE_MODULES) expect(files.map((f) => f.rel)).toContain(m);
  });

  it('no module outside the gate computes the rule (minVisibleSeq, editsSomewhere, visibleFrom)', () => {
    const copies: string[] = [];
    for (const f of files) {
      if (GATE_MODULES.has(f.rel)) continue;
      const lines = readFileSync(f.path, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (METHOD_DEFINITION.test(line)) return;
        for (const re of RULE_CALLS)
          if (re.test(line)) copies.push(`${f.rel}:${i + 1} matches ${re.source}`);
      });
    }
    expect(copies).toEqual([]);
  });

  it('the routes that take a sequence number call the control-plane gate', () => {
    for (const rel of [
      'control-plane/commit-routes.ts',
      'control-plane/export-routes.ts',
      'control-plane/field-routes.ts',
      'control-plane/handlers.ts',
      'control-plane/history-routes.ts',
      'control-plane/restore-route.ts',
    ]) {
      const text = readFileSync(join(SRC, rel), 'utf8');
      expect(text, rel).toMatch(/minVisibleSeqOf\(/);
    }
  });

  it('the control-plane gate delegates the rule: no search of its own, no threshold comparison', () => {
    const text = readFileSync(join(SRC, 'control-plane/gate.ts'), 'utf8');
    expect(text).toMatch(/minVisibleSeqAsync\(/);
    expect(text).toMatch(/stateAllowed\(/);
    // The binary search of since_access and the comparison of a seq with the gate live in the
    // authority (`sinceAccessSearch`, `stateVisible`) and nowhere in this module.
    expect(text).not.toMatch(/while \(lo <= hi\)/);
    expect(text).not.toMatch(/seq\s*>=\s*min|seq\s*<\s*min/);
  });

  it('no route compares a seq with the gate itself', () => {
    const copies: string[] = [];
    for (const f of files) {
      // The stores take the gate as a parameter (`min`) and filter by it; they do not compute it.
      if (GATE_MODULES.has(f.rel) || f.rel.startsWith('storage/')) continue;
      readFileSync(f.path, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/\b(?:seq|toSeq|atSeq|fromSeq|after)\s*(?:<|>=)\s*min\b/.test(line))
            copies.push(`${f.rel}:${i + 1}`);
        });
    }
    expect(copies).toEqual([]);
  });
});
