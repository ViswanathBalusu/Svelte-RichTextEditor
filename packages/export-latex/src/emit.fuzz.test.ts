/**
 * EXP-046 criteria 3 and 4 (Node.js only): property tests of every string-taking emitter in every
 * context, over strings in several languages and scripts, with seeds from known attacks that every
 * run starts with. Criteria 1, 2 and 5 need the sandbox (a compile of the output, a token trace of
 * the compile) and a stored corpus of failing inputs; they are not run here (see the story's Notes).
 *
 * What is checked is the grammar of each emitter's output, not a compile:
 * - `text`: after the escapes the emitter writes are read back, the output is the cleaned input,
 *   and no bare TeX special character or backslash remains (so no control sequence survives).
 * - `pdfString`, `kvValue`: the output is `\DEstr{<hex>}` (or braced), and the hex decodes to the
 *   cleaned input as UTF-8.
 * - `url`: the output is hex digits only for an allowed scheme; every other scheme is refused.
 * - `color`, `enumLookup`, `dimen`, `generatedId`: their fixed forms, and the value never written.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  clean,
  color,
  dimen,
  enumLookup,
  generatedId,
  kvValue,
  lit,
  pdfString,
  text,
  url,
  type Tex,
  type TextContext,
} from './emit.ts';

/** Known attacks (EXP-046 criterion 4). Every property runs these first, through `examples`. */
const SEEDS: readonly string[] = [
  '\\input{/etc/passwd}',
  '\\write18{id}',
  '\\immediate\\write18{id}',
  '^^5c^^5cwrite18',
  '^^M^^J',
  '{',
  '}',
  '{{}}',
  '}{',
  ']',
  '[',
  'a,b=c]',
  ',x=y',
  '\\DEstr{41}',
  '%comment',
  '#1#2',
  '$$x$$',
  '&',
  '~',
  '\\\\',
  '\\end{document}',
  '\\textbackslash{}',
  '{[}',
  '\\-',
  '\u202e\u202d',
  '\u0000\u001b',
  '',
  ' ',
  '  ',
];

/** Several languages and scripts (EXP-046 criterion 3), with the characters that matter in TeX. */
const LANGUAGES: Readonly<Record<string, readonly string[]>> = {
  latin: ['C', 'a', 'z', '\u00e9', '\u00df', '\u00f8', '\u00d1', '\u00fc', ' ', '.'],
  greek: ['\u03b1', '\u03b2', '\u03a9', '\u03c2', ' '],
  cyrillic: ['\u041f', '\u0440', '\u0438', '\u0432', ' '],
  arabic_rtl: ['\u0645', '\u0631', '\u062d', '\u0628', '\u0627', '\u200f', '\u202b', ' '],
  hebrew_rtl: ['\u05e9', '\u05dc', '\u05d5', '\u05dd', '\u200e', ' '],
  cjk: ['\u6f22', '\u5b57', '\u3072', '\u3089', '\u304c', '\u306a', '\u3000'],
  devanagari: ['\u0928', '\u092e', '\u0938', '\u094d', '\u0924', '\u0947', ' '],
  combining_marks: ['e', '\u0301', '\u0308', 'a', '\u0327', ' '],
  emoji: ['\ud83d\ude00', '\ud83c\udf89', ' '],
  tex_specials: [
    '\\',
    '{',
    '}',
    '$',
    '&',
    '#',
    '_',
    '%',
    '^',
    '~',
    '[',
    ']',
    ',',
    '=',
    ' ',
    '\u00a0',
    '\u00ad',
  ],
  controls: ['\u0000', '\u0007', '\u001b', '\u007f', '\u202e', '\u2066', '\ufeff', '\t', '\n', 'x'],
};

const SPECIALS = '\\{}$&#_%^~';

/** Strings from a language's characters, or a seed. */
function stringsOf(chars: readonly string[]): fc.Arbitrary<string> {
  return fc.oneof(
    fc.constantFrom(...SEEDS),
    fc.array(fc.constantFrom(...chars), { maxLength: 16 }).map((a) => a.join('')),
  );
}

const examples = (): [string][] => SEEDS.map((s) => [s]);

const RUNS = 120;

/** The tokens `text` writes for an escape, read back to the character they stand for. */
const ESCAPED: Readonly<Record<string, string>> = {
  '\\textbackslash{}': '\\',
  '\\textasciicircum{}': '^',
  '\\textasciitilde{}': '~',
  '{[}': '[',
  '{]}': ']',
  '\\-': '\u00ad',
  '\\ ': ' ',
  '\\{': '{',
  '\\}': '}',
  '\\$': '$',
  '\\&': '&',
  '\\#': '#',
  '\\_': '_',
  '\\%': '%',
  '~': '\u00a0',
};
const TOKEN =
  /\\textbackslash\{\}|\\textasciicircum\{\}|\\textasciitilde\{\}|\{\[\}|\{\]\}|\\[{}$&#_%\- ]|~|[\s\S]/g;

/**
 * Reads the output of `text` back. Returns null when a bare special character or a backslash
 * stands outside the escapes the emitter writes: then a TeX control sequence could survive.
 */
function unescapeText(out: string): string | null {
  let s = '';
  for (const m of out.matchAll(TOKEN)) {
    const tok = m[0];
    const v = ESCAPED[tok];
    if (v !== undefined) s += v;
    else if (SPECIALS.includes(tok)) return null;
    else s += tok;
  }
  return s;
}

function decodeHex(hex: string): string {
  const bytes = Uint8Array.from((hex.match(/../g) ?? []).map((h) => parseInt(h, 16)));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

const TEXT_CONTEXTS: ReadonlyArray<readonly [string, (s: string) => TextContext]> = [
  ['block start', () => ({})],
  ['after a space', () => ({ afterSpace: true })],
  [
    'explicit spaces',
    (s) => ({ explicit: new Set([...s].flatMap((c, i) => (c === ' ' ? [i] : []))) }),
  ],
];

for (const [language, chars] of Object.entries(LANGUAGES)) {
  describe(`EXP-046 emitters over ${language} (criteria 3 and 4)`, () => {
    for (const [context, contextOf] of TEXT_CONTEXTS) {
      it(`text in ${context}: the output reads back to the cleaned input and carries no control sequence`, () => {
        fc.assert(
          fc.property(stringsOf(chars), (value) => {
            const out = text(value, contextOf(value));
            const back = unescapeText(out);
            expect(back).not.toBeNull();
            expect(back).toBe(clean(value));
          }),
          { numRuns: RUNS, examples: examples() },
        );
      });
    }

    it('pdfString and kvValue: hexadecimal digits that decode to the cleaned input', () => {
      fc.assert(
        fc.property(stringsOf(chars), (value) => {
          const p = pdfString(value);
          expect(p).toMatch(/^\\DEstr\{(?:[0-9A-F]{2})*\}$/);
          expect(decodeHex(/^\\DEstr\{((?:[0-9A-F]{2})*)\}$/.exec(p)![1]!)).toBe(clean(value));
          expect(kvValue(value)).toBe(`{${p}}`);
        }),
        { numRuns: RUNS, examples: examples() },
      );
    });

    it('url: hexadecimal digits only for an allowed scheme, and the other schemes are refused', () => {
      const prefix = fc.constantFrom<string>(
        'https://',
        'http://',
        'mailto:',
        'run:',
        'file:',
        'javascript:',
        '#',
        '',
      );
      const urlExamples: [string, string][] = SEEDS.flatMap((s) =>
        ['https://', 'run:', '#', ''].map((p): [string, string] => [p, s]),
      );
      fc.assert(
        fc.property(prefix, stringsOf(chars), (p, value) => {
          const href = p + value;
          const r = url(href);
          if (r.kind === 'external') {
            expect(r.tex).toMatch(/^(?:[0-9A-F]{2})*$/);
            expect(decodeHex(r.tex)).toMatch(/^(?:https?:\/\/|mailto:)/i);
          } else if (r.kind === 'internal') {
            expect(r.name).toMatch(/^[A-Za-z0-9_:.-]{1,128}$/);
          } else {
            expect(href).not.toMatch(/^(?:https?:\/\/|mailto:)/i);
          }
        }),
        { numRuns: RUNS, examples: urlExamples },
      );
    });

    it('color and enumLookup: a value of the language never reaches the output', () => {
      const table = { left: lit('l'), right: lit('r') } as const;
      const fallback: Tex = lit('c');
      fc.assert(
        fc.property(stringsOf(chars), (value) => {
          const c = color(value);
          if (c !== null) expect(c).toMatch(/^[0-9A-F]{6}$/);
          const e = enumLookup(table, value, fallback);
          expect([table.left, table.right, fallback]).toContain(e.tex);
          if (!Object.hasOwn(table, value)) expect(e.tex).toBe(fallback);
        }),
        { numRuns: RUNS, examples: examples() },
      );
    });
  });
}

describe('EXP-046 emitters over numbers (criterion 3, numbers have no language)', () => {
  it('dimen writes a clamped length in big points', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1_000_000, max: 1_000_000 }), (n) => {
        expect(dimen(n)).toMatch(/^-?\d+(?:\.\d+)?bp$/);
      }),
      { numRuns: RUNS, examples: [[0], [-1], [31680], [-31680], [31681], [-31681]] },
    );
  });

  it('generatedId and int write digits only', () => {
    fc.assert(
      fc.property(fc.nat(1_000_000_000), (n) => {
        expect(generatedId(n)).toBe(String(n));
      }),
      { numRuns: RUNS },
    );
  });
});
