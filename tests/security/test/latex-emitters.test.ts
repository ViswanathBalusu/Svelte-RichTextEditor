/**
 * SEC-033 — every path by which a user's string reaches TeX is tested as hostile (10 §3.4; 09 §4).
 *
 * This file runs the real emitters of `packages/export-latex/src/emit.ts` against hostile strings
 * and checks the output at the token level: the source of what the emitter wrote, not a compile.
 * The compiled oracle of criterion 1 (extracted text equal to the input, token trace of the PDF)
 * needs the sandbox of SEC-035 under Podman, so criterion 1 is not ticked. The static check of
 * criterion 4 is in the second describe block, which re-runs the forgery scan over the converter.
 *
 * Node.js only. The emitters are imported by relative path, so this package needs no dependency.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  color,
  dimen,
  generatedId,
  kvValue,
  letters,
  int,
  pdfString,
  text,
  url,
} from '../../../packages/export-latex/src/emit.ts';

const RUNS = Number(process.env['FUZZ_RUNS'] ?? 200);
const SRC = fileURLToPath(new URL('../../../packages/export-latex/src/', import.meta.url));

/** Hostile seeds named in criterion 1, given to every property as known attacks. */
const SEEDS = [
  '\\write18{rm -rf /}',
  '\\directlua{os.execute("id")}',
  '\\input{/etc/passwd}',
  '^^5cwrite18',
  '}\\def\\x{',
  '%comment\n\\section{x}',
  '\n[bracket after a line break',
  '\u202eevil\u202c',
  '\u0000\u0007\u007f\u009b',
  '\\\\ \\& \\$ \\# \\_ \\% \\^ \\~',
  'a'.repeat(5000),
];

const hostile = fc.oneof(
  fc.constantFrom(...SEEDS),
  fc.string({ maxLength: 60 }),
  fc.string({ unit: 'binary', maxLength: 40 }),
  fc
    .array(fc.constantFrom('\\', '{', '}', '%', '#', '&', '$', '^', '~', '[', ']', '_', ' ', 'a'), {
      maxLength: 40,
    })
    .map((cs) => cs.join('')),
);

/** The escapes `text` writes; anything else with a backslash is not an emitter's output. */
const TEXT_ESCAPE = /\\(?:textbackslash\{\}|textasciicircum\{\}|textasciitilde\{\}|[{}$&#_%\- ])/g;

describe('SEC-033 criterion 1 (token part): emitter output holds no control sequence it did not write', () => {
  it('text: every backslash is one of its own escapes, and no special is left unescaped', () => {
    fc.assert(
      fc.property(hostile, (value) => {
        const out = text(value) as string;
        // Brackets are written only as {[} and {]}, the guard against an optional argument.
        const bare = out.replace(/\{\[\}|\{\]\}/g, '');
        expect(bare).not.toMatch(/[[\]]/);
        const stripped = out.replace(TEXT_ESCAPE, '').replace(/\{[[\]]\}/g, '');
        expect(stripped).not.toContain('\\');
        expect(stripped).not.toMatch(/[{}$&#_%^]/);
      }),
      { numRuns: RUNS },
    );
  });

  it('text: a hostile control word never appears as a control word in the output', () => {
    fc.assert(
      fc.property(hostile, (value) => {
        const out = text(value) as string;
        expect(out).not.toMatch(/\\(?:write|directlua|input|def|immediate|special|csname)\b/);
      }),
      { numRuns: RUNS },
    );
  });

  it('text: bidirectional overrides and control characters are removed', () => {
    fc.assert(
      fc.property(hostile, (value) => {
        const out = text(value) as string;
        // A code-point check rather than a regex: eslint's no-control-regex refuses \x00 to \x1f.
        const forbidden = [...out].filter((ch) => {
          const c = ch.codePointAt(0) ?? 0;
          return (
            c <= 0x1f ||
            (c >= 0x7f && c <= 0x9f) ||
            (c >= 0x202a && c <= 0x202e) ||
            (c >= 0x2066 && c <= 0x2069) ||
            c === 0xfeff
          );
        });
        expect(forbidden).toEqual([]);
      }),
      { numRuns: RUNS },
    );
  });

  it('pdfString and kvValue: the output is hexadecimal digits inside \\DEstr, nothing else', () => {
    fc.assert(
      fc.property(hostile, (value) => {
        expect(pdfString(value) as string).toMatch(/^\\DEstr\{[0-9A-F]*\}$/);
        expect(kvValue(value) as string).toMatch(/^\{\\DEstr\{[0-9A-F]*\}\}$/);
      }),
      { numRuns: RUNS },
    );
  });

  it('url: an accepted link is hexadecimal, a refused one carries no TeX', () => {
    fc.assert(
      fc.property(hostile, (href) => {
        const r = url(href);
        if (r.kind === 'external') expect(r.tex as string).toMatch(/^[0-9A-F]+$/);
        if (r.kind === 'internal') expect(r.name).toMatch(/^[A-Za-z0-9_:.-]{1,128}$/);
      }),
      { numRuns: RUNS },
    );
    for (const href of ['javascript:alert(1)', 'file:///etc/passwd', '\\input{x}', 'ftp://x']) {
      expect(url(href).kind).toBe('refused');
    }
  });

  it('color: exactly six hexadecimal digits or nothing', () => {
    fc.assert(
      fc.property(hostile, (value) => {
        const out = color(value);
        if (out !== null) expect(out as string).toMatch(/^[0-9A-F]{6}$/);
      }),
      { numRuns: RUNS },
    );
  });

  it('dimen, int, letters and generatedId: only digits, letters or a bounded length', () => {
    fc.assert(
      fc.property(fc.integer(), (n) => {
        expect(dimen(n) as string).toMatch(/^-?[0-9]+(?:\.[0-9]+)?(?:bp)?$/);
        expect(int(Math.abs(n))).toBeDefined();
      }),
      { numRuns: RUNS },
    );
    fc.assert(
      fc.property(fc.nat(), (n) => {
        expect(letters(n) as string).toMatch(/^[a-z]+$/);
        expect(generatedId(n) as string).toMatch(/^[0-9]+$/);
      }),
      { numRuns: RUNS },
    );
  });
});

/** Every non-test source file of the converter, as paths relative to its source root. */
function convertorSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...convertorSources(path));
    else if (name.endsWith('.ts') && !/\.test\.ts$/.test(name)) out.push(path);
  }
  return out;
}

describe('SEC-033 criterion 4: the converter has no path from a user string to TeX outside an emitter', () => {
  it('no module but emit.ts casts a value to Tex or calls the emitter constructor', () => {
    // A value of type `string` is not accepted where `Tex` is required, so a cast is the only way
    // around the emitters. Casts are searched in every converter source, tests excluded.
    const forgery = [/\bas\s+(?:unknown\s+as\s+)?Tex\b/, /\basTex\s*\(/, /\btexBrand\b/];
    const offenders: string[] = [];
    for (const file of convertorSources(SRC)) {
      if (relative(SRC, file) === 'emit.ts') continue;
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (forgery.some((p) => p.test(line))) offenders.push(`${relative(SRC, file)}:${i + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  it('the converter sources were scanned (the check is not vacuous)', () => {
    expect(convertorSources(SRC).length).toBeGreaterThan(20);
  });
});
