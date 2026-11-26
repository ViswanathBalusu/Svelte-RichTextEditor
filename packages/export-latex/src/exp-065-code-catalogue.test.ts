/**
 * EXP-065 criterion 4, the converter's half (Node.js only): every code the converter and the
 * direct writers can put into a result is in `DIAGNOSTIC_CODES` (`diagnostic-codes.ts`), which the
 * export worker publishes in `spec/export/diagnostic-codes-1.json`.
 *
 * The compiler already refuses an unlisted code in `diag`, `warnOnce` and `note` (their `code`
 * parameter is a `DiagnosticCode`). This test covers what the type does not: the places that build
 * a `Diagnostic` as an object (`code: '...'`, the preflight's union of codes), the severity written
 * at a call that names one, and entries that nothing emits any more.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DIAGNOSTIC_CODE_PATTERNS, DIAGNOSTIC_CODES, type DiagnosticCodeInfo } from './index.ts';

const SRC = fileURLToPath(new URL('.', import.meta.url));
const MODEL_STYLES = fileURLToPath(new URL('../../model/src/cascade/styles.ts', import.meta.url));

function sources(dir: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'diagnostic-codes.ts')
      out.push({ file: p.slice(SRC.length), text: readFileSync(p, 'utf8') });
  }
  return out;
}

const FILES = sources(SRC);
const CATALOGUE = DIAGNOSTIC_CODES as Record<string, DiagnosticCodeInfo>;
const isPlain = (code: string): boolean => code.endsWith('_plain');

interface Use {
  file: string;
  code: string;
  severity: string | null;
}

/** The codes written as literals: calls of `diag`, `note` and `warnOnce`, `code: '...'` and the preflight union. */
function uses(): Use[] {
  const out: Use[] = [];
  for (const { file, text } of FILES) {
    let m: RegExpExecArray | null;
    const call =
      /\b(?:diag|note)\(\s*[\w.]+(?: as \w+)?,\s*(?:'(error|warning|info)'|[^,'()]+(?:\([^)]*\))?[^,'()]*),\s*'([a-z0-9_]+)'/g;
    while ((m = call.exec(text))) out.push({ file, code: m[2]!, severity: m[1] ?? null });
    const once = /\bwarnOnce\(\s*[\w.]+,\s*'([a-z0-9_]+)'/g;
    while ((m = once.exec(text))) out.push({ file, code: m[1]!, severity: 'warning' });
    const lit = /\bcode:\s*'([a-z0-9_]+)'/g;
    while ((m = lit.exec(text))) out.push({ file, code: m[1]!, severity: null });
    const union = /^\s*\| '([a-z0-9_]+)'$/gm;
    while ((m = union.exec(text))) out.push({ file, code: m[1]!, severity: null });
  }
  return out;
}

describe('EXP-065 criterion 4: the converter lists every code it can emit', () => {
  const found = uses();

  it('finds a worthwhile number of uses, so that the scan is not empty', () => {
    expect(found.length).toBeGreaterThan(80);
  });

  it('has every code written in the source in the catalogue', () => {
    const missing = found.filter((u) => !(u.code in CATALOGUE) && !isPlain(u.code));
    expect(missing.map((u) => `${u.file}: ${u.code}`)).toEqual([]);
  });

  it("writes a severity that is the catalogue's, unless the entry says it varies", () => {
    const wrong = found.filter((u) => {
      const e = CATALOGUE[u.code];
      return (
        u.severity !== null &&
        e !== undefined &&
        e.severity !== u.severity &&
        !e.note?.match(/final export|error in/i)
      );
    });
    expect(wrong.map((u) => `${u.file}: ${u.code} is ${u.severity}`)).toEqual([]);
  });

  it('has no entry that nothing emits', () => {
    const styles = readFileSync(MODEL_STYLES, 'utf8');
    const stale = Object.keys(CATALOGUE).filter(
      (code) =>
        !found.some((u) => u.code === code) &&
        !FILES.some((f) => f.text.includes(`'${code}'`)) &&
        !styles.includes(`'${code}'`),
    );
    expect(stale).toEqual([]);
  });

  it('names every code in lower-case snake case, once, with a sentence', () => {
    for (const [code, e] of Object.entries(CATALOGUE)) {
      expect(code).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/);
      expect(e.message.length).toBeGreaterThan(10);
      expect(e.message.endsWith('.')).toBe(true);
    }
    expect(Object.keys(CATALOGUE)).toEqual([...Object.keys(CATALOGUE)].sort());
  });

  it('lists the open family of mark codes as a pattern', () => {
    expect(DIAGNOSTIC_CODE_PATTERNS.map((p) => p.pattern)).toEqual(['<mark>_plain']);
  });
});
