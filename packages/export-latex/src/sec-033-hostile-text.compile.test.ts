/**
 * SEC-033 criteria 1 (the `text` emitter) and 3 (10 §3.4; 09 §4, §14), compiled in the sandbox.
 *
 * Criterion 1, `text`: the hostile values the criterion names that the batch of EXP-046
 * (`emit.compile.fuzz.test.ts`) does not hold are typeset as body text, and the text extracted from
 * the PDF (`pdftotext -raw`) equals the input: `\directlua`, `\write18` after `\immediate`,
 * `\csname`, `^^` notation in its two- and four-digit forms, unbalanced braces, `%`, a `[` straight
 * after a line break (where `\\` would read an optional argument), bidirectional overrides and
 * control characters (which `clean` removes, so the expected text is the cleaned input), and a
 * very long input (20,000 characters of specials in words, compared with the white space of the
 * line breaks removed).
 *
 * Criterion 3: for each language of the converter's table (`LANGUAGES`), runs marked with the
 * language hold strings a language module could rewrite (the shorthand characters of babel's
 * modules: `"`, `~`, `'`, `` ` ``, `^`, `;`, `:`, `!`, `?`, `<<`, `>>`) next to the injection
 * seeds, and each comes out of the PDF as typed; eight fast-check samples (a fixed seed for each
 * language) of random strings over those characters, the TeX specials and a few letters follow
 * them. The whole table is in one document, so every language's module is loaded in the compile.
 *
 * The compile runs in the real sandbox (Podman, the worker image). The test skips when
 * `sandboxReady()` reports that sandboxed compiles cannot run here.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { clean } from './emit.ts';
import { LANGUAGES } from './languages.ts';
import { doc, nid, para, type J } from '../test/docs.ts';
import { convertAndCompile, pdfText, sandboxReady } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const OPTIONS = {
  profile: 'preview',
  instant: '2026-11-06T10:00:00.000Z',
  timeZone: 'Europe/London',
  suggestions: 'accept',
} as const;

const RLO = String.fromCharCode(0x202e);
const PDF = String.fromCharCode(0x202c);
const LRI = String.fromCharCode(0x2066);
const PDI = String.fromCharCode(0x2069);
const controls = (...codes: number[]) => codes.map((c) => String.fromCharCode(c));

/** One line each; the expected line is the cleaned input. */
const HOSTILE: readonly string[] = [
  '\\directlua{os.execute("id")}',
  '\\directlua{io.popen("id")}x',
  '\\immediate\\write18{touch pwned}',
  '\\csname input\\endcsname{/etc/passwd}',
  '\\catcode`\\@=0 @input{main.aux}',
  '^^M^^5cdirectlua{os.exit()}',
  '^^^^005cinput ^^^^^^00005c',
  '}}}{{{ %%% \\\\ \\',
  '%\\fi\\fi\\endgroup\\end{document}',
  `abc${RLO}def${PDF}ghi ${LRI}jkl${PDI}`,
  ['a', ...controls(0x00, 0x07), 'b', ...controls(0x1b, 0x7f, 0x85), 'c'].join(''),
  '\\def\\x{\\x}\\x \\loop\\iftrue\\repeat',
];

/** After a line break: `\\` followed by `[` would take the bracket as its optional argument. */
const AFTER_BREAK = ['before the break', '[12pt] after the break', '*[3em] and a star'];

/** 20,000 characters: words of specials, so that lines break and nothing is a plain letter run. */
const LONG_WORD = '\\a{b}%c#d&e_f$g^h~i[j]k';
const LONG = Array.from({ length: Math.ceil(20_000 / (LONG_WORD.length + 1)) }, () => LONG_WORD)
  .join(' ')
  .slice(0, 20_000)
  .trimEnd();

/** Strings a language module could rewrite, with injection seeds; each short enough for one line. */
const PER_LANGUAGE: readonly string[] = [
  '"a "o "s "| "- "= "\' "` "< "> ""',
  "~n ~N 'a 'e `a ^e ^^5c | @ ' `",
  'x; y: z! w? <<q>> ,,r -- --- ?` !`',
  '\\write18{id} \\directlua{x} {~}%#&_$',
];

const TAGS = Object.keys(LANGUAGES);

/** The alphabet of the random strings: the shorthand characters, the TeX specials, a few letters. */
const ALPHABET = [...'aenosAENOS019', ...'"~\'`^;:!?<>,.-|@=/', ...'\\{}$&#_%[]', ' '];
const RANDOM_PER_LANGUAGE = 8;

/** Fixed-seed random strings for the language at index `t`: a different sample for each language. */
function randomFor(t: number): string[] {
  const candidate = fc
    .array(fc.constantFrom(...ALPHABET), { minLength: 1, maxLength: 30, size: 'large' })
    .map((a) => a.join(''))
    .filter((s) => !/^ | $| {2}/.test(s));
  return fc.sample(candidate, { seed: 3300 + t, numRuns: RANDOM_PER_LANGUAGE });
}

/** The PDF's lines, ligature glyphs expanded (NFKC) and trailing spaces removed. */
function lines(text: string): string[] {
  return text
    .normalize('NFKC')
    .split(/\r?\n|\f/)
    .map((l) => l.replace(/\s+$/, ''));
}

async function compiledText(body: J[], title: string): Promise<string> {
  const c = await convertAndCompile(doc(body), { ...OPTIONS, title } as never);
  if (!c.compile.ok || !c.compile.pdf)
    throw new Error(`the compile failed:\n${c.compile.log.slice(-1500)}`);
  const text = pdfText(c.compile.pdf);
  if (text === null) throw new Error('pdftotext is not installed or failed');
  return text;
}

describe('SEC-033: the hostile batches', () => {
  it('hold what the criteria name, and the cleaned forms differ only where clean removes', () => {
    expect(TAGS.length).toBeGreaterThanOrEqual(33);
    expect(LONG.length).toBeGreaterThan(19_900);
    expect(HOSTILE.filter((s) => clean(s) !== s)).toHaveLength(2);
    for (const s of [...HOSTILE, ...PER_LANGUAGE]) expect(clean(s).length).toBeLessThanOrEqual(45);
    // ASCII apart from the removed characters, so NFKC leaves every expected line unchanged.
    for (const s of [...HOSTILE, ...PER_LANGUAGE, ...AFTER_BREAK, LONG])
      expect(clean(s).normalize('NFKC')).toBe(clean(s));
  });
});

describe.skipIf(!ready)(
  'SEC-033 criterion 1: hostile body text comes out of the PDF as typed',
  () => {
    it('typesets the hostile values, a bracket after a line break and a very long input', async () => {
      const body: J[] = [
        ...HOSTILE.map((s) => para(s)),
        {
          type: 'paragraph',
          attrs: { id: nid('p') },
          content: AFTER_BREAK.flatMap((s, i) => [
            ...(i > 0 ? [{ type: 'break' }] : []),
            { type: 'text', text: s },
          ]),
        },
        para('LONGSTART'),
        para(LONG),
        para('LONGEND'),
      ];
      const text = await compiledText(body, 'sec-033-hostile-text');
      const out = lines(text);
      const have = new Set(out);
      expect(HOSTILE.map(clean).filter((s) => !have.has(s))).toEqual([]);
      // The three lines of the paragraph with breaks, in order and next to each other.
      const at = out.indexOf(AFTER_BREAK[0]!);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(out.slice(at, at + AFTER_BREAK.length)).toEqual(AFTER_BREAK);
      // The long input, between its markers, with the white space of the line breaks removed.
      const flat = text.normalize('NFKC');
      const from = flat.indexOf('LONGSTART');
      const to = flat.indexOf('LONGEND');
      expect(from).toBeGreaterThanOrEqual(0);
      expect(to).toBeGreaterThan(from);
      const between = flat.slice(from + 'LONGSTART'.length, to).replace(/\s+/g, '');
      expect(between).toBe(LONG.replace(/\s+/g, ''));
    }, 600_000);
  },
);

describe.skipIf(!ready)('SEC-033 criterion 3: the text oracle holds in every language', () => {
  it('typesets the shorthand characters and the seeds in a run of each language', async () => {
    const expected: string[] = [];
    const body: J[] = [];
    TAGS.forEach((tag, t) => {
      [...PER_LANGUAGE, ...randomFor(t)].forEach((s, i) => {
        const mark = `L${String(t).padStart(2, '0')}${String.fromCharCode(97 + i)} `;
        expected.push(mark + s);
        body.push({
          type: 'paragraph',
          attrs: { id: nid('p') },
          content: [
            { type: 'text', text: mark },
            { type: 'text', text: s, marks: [{ type: 'lang', attrs: { value: tag } }] },
          ],
        });
      });
    });
    const c = await convertAndCompile(doc(body), {
      ...OPTIONS,
      title: 'sec-033-languages',
    } as never);
    // Every language of the table is declared in the compiled source, so its module is loaded:
    // the document's own language (en-GB) by the class's babel line, the others by `\DEdeflang`.
    const main = String(c.bundle.files['main.tex']);
    expect((main.match(/\\DEdeflang\{/g) ?? []).length).toBe(TAGS.length - 1);
    expect(c.bundle.diagnostics.filter((d) => d.code === 'language_unknown')).toEqual([]);
    if (!c.compile.ok || !c.compile.pdf)
      throw new Error(`the compile failed:\n${c.compile.log.slice(-1500)}`);
    const text = pdfText(c.compile.pdf);
    if (text === null) throw new Error('pdftotext is not installed or failed');
    const have = new Set(lines(text));
    const missing = expected.filter((s) => !have.has(s));
    const tagOf = (line: string) => TAGS[Number(line.slice(1, 3))];
    expect(missing.map((s) => `${tagOf(s)}: ${s}`)).toEqual([]);
  }, 900_000);
});
