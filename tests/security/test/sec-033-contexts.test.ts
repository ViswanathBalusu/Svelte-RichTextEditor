/**
 * SEC-033 criteria 2 and 3: every context in which a user string reaches TeX has a test with hostile
 * values (10 §3.4; 09 §4), and, for each supported language (EXP-027), the converter half of the
 * `text` oracle: what the converter writes per language. The compiled half is not run here.
 *
 * The emitters are the real ones of `packages/export-latex/src/emit.ts`, called the way the converter
 * calls them (`text` for body text, `kvValue` for alternative text and field labels, `pdfString` for
 * PDF metadata and bookmarks, `url` for links, `color`, `dimen`). The oracle is token-level, as in
 * `latex-emitters.test.ts`: it reads what the emitter wrote, not a compiled PDF. The compiled oracle
 * needs the sandbox of SEC-035 under Podman and is not run here.
 *
 * Node.js only (vitest, fast-check). No network, no Podman.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  color,
  dimen,
  kvValue,
  pdfString,
  text,
  url,
} from '../../../packages/export-latex/src/emit.ts';
import { LANGUAGES } from '../../../packages/export-latex/src/languages.ts';
import { doc, para, run, type J } from '../../../packages/export-latex/test/docs.ts';

const RUNS = Number(process.env['FUZZ_RUNS'] ?? 200);

/** Hostile seeds named in SEC-033 criterion 1, plus contexts' own delimiters. */
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
  '$$ \\DEstr{41} ) ] ]]',
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

/** Body-text oracle: only the emitter's own escapes, no bare special, no bare bracket. */
function expectTextToken(out: string): void {
  const bare = out.replace(/\{\[\}|\{\]\}/g, '');
  expect(bare).not.toMatch(/[[\]]/);
  const stripped = out.replace(TEXT_ESCAPE, '').replace(/\{[[\]]\}/g, '');
  expect(stripped).not.toContain('\\');
  expect(stripped).not.toMatch(/[{}$&#_%^~]/);
}

/** Hex-string oracle: `\DEstr{HEX}`, optionally wrapped once in braces (kvValue), nothing else. */
function expectHexString(out: string): void {
  expect(out).toMatch(/^\{?\\DEstr\{[0-9A-F]*\}\}?$/);
}

describe('SEC-033 criterion 2: body text (text) with hostile values', () => {
  it('writes only its own escapes', () => {
    fc.assert(
      fc.property(hostile, (value) => {
        expectTextToken(text(value) as string);
      }),
      { numRuns: RUNS },
    );
  });

  it('keeps a hostile control word from appearing as a control word', () => {
    fc.assert(
      fc.property(hostile, (value) => {
        const out = text(value) as string;
        expect(out).not.toMatch(/\\(?:write18|directlua|input|def|section)\b/);
      }),
      { numRuns: RUNS },
    );
  });
});

describe('SEC-033 criterion 2: alternative text, field labels and PDF metadata (kvValue, pdfString)', () => {
  it('kvValue (alternative text, field labels, PDF title) is a hexadecimal string', () => {
    fc.assert(
      fc.property(hostile, (value) => {
        expectHexString(kvValue(value) as string);
      }),
      { numRuns: RUNS },
    );
  });

  it('pdfString (bookmarks, heading and figure placeholders, metadata) is a hexadecimal string', () => {
    fc.assert(
      fc.property(hostile, (value) => {
        expectHexString(pdfString(value) as string);
      }),
      { numRuns: RUNS },
    );
  });
});

describe('SEC-033 criterion 2: link targets (url)', () => {
  it('an external target is hexadecimal; an internal target is a bounded name; anything else is refused', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          hostile,
          fc
            .tuple(fc.constantFrom('https://', 'http://', 'mailto:', 'HTTPS://'), hostile)
            .map(([p, s]) => p + s),
          fc.string({ maxLength: 40 }).map((s) => `#${s}`),
        ),
        (href) => {
          const r = url(href);
          if (r.kind === 'external') expect(r.tex as string).toMatch(/^[0-9A-Fa-f]*$/);
          else if (r.kind === 'internal') expect(r.name).toMatch(/^[A-Za-z0-9_:.-]{1,128}$/);
          else expect(r.reason.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

describe('SEC-033 criterion 2: colours (color) and lengths (dimen)', () => {
  it('a colour is six hexadecimal digits or null', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          hostile,
          fc.constantFrom('#1F5FAD', '#zz0000', '#1F5FAD\\write18', null, undefined),
        ),
        (value) => {
          const out = color(value as string | null | undefined);
          if (out !== null) expect(out as string).toMatch(/^[0-9A-F]{6}$/);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('a length is a plain number with an optional bp unit, for any hostile numeric input', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer(),
          fc.double(),
          fc.constantFrom(Number.NaN, Infinity, -Infinity, Number.MAX_VALUE),
        ),
        (n) => {
          expect(dimen(n) as string).toMatch(/^-?[0-9]+(?:\.[0-9]+)?(?:bp)?$/);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

/*
 * Criterion 3 asks that the `text` oracle hold for each language, "because language modules can
 * rewrite text". Only a compile can show what babel does to the characters; that run needs the
 * sandbox under Podman (or `typeset.compile.test.ts` with an engine) and is not here, so the
 * criterion stays open. What the converter can be held to without a compile is checked below, per
 * language: the converter's own output. For each tag of the table it writes the babel setup of that
 * tag and nothing else that depends on the language, and the hostile text inside a language switch
 * is token for token what it writes without one.
 */

/** A run of `value` after "Plain. ", marked with the language `tag`. */
function markedPara(value: string, tag: string): J {
  return para('Plain. ', {}, [
    { type: 'text', text: value, marks: [{ type: 'lang', attrs: { value: tag } }] },
  ]);
}

/** A tag the table does not hold: the run is split out but no language switch is written. */
const UNKNOWN_TAG = 'xx-YY';

const values = fc.array(
  hostile.filter((s) => s.length > 0),
  { minLength: 1, maxLength: 6 },
);
const LANG_RUNS = Math.max(3, Math.floor(RUNS / 40));

/** The end of the group that opens before `from`: braces are counted, a control symbol or word skipped. */
function groupEnd(s: string, from: number): number {
  let depth = 1;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      const word = /^[A-Za-z]+/.exec(s.slice(i + 1));
      i += word ? word[0].length : 1;
    } else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

/**
 * The texts of the runs inside `\DElang{k}{...}%`: a sequence of `\DEr{n}{X}`. Anything between the
 * runs is returned too, so the caller can check that the wrapper holds runs and nothing else.
 */
function wrappedRuns(lineText: string): { texts: string[]; between: string[] } {
  const head = /^\\DElang\{\d+\}\{/.exec(lineText);
  expect(head, `not a language line: ${lineText}`).not.toBeNull();
  const end = groupEnd(lineText, head![0].length);
  expect(lineText.slice(end), lineText).toBe('}%');
  const inner = lineText.slice(head![0].length, end);
  const texts: string[] = [];
  const between: string[] = [];
  let i = 0;
  while (i < inner.length) {
    const r = /\\DEr\{\d+\}\{/g;
    r.lastIndex = i;
    const m = r.exec(inner);
    if (!m) {
      between.push(inner.slice(i));
      break;
    }
    if (m.index > i) between.push(inner.slice(i, m.index));
    const close = groupEnd(inner, m.index + m[0].length);
    expect(close, lineText).toBeGreaterThan(0);
    texts.push(inner.slice(m.index + m[0].length, close));
    i = close + 1;
  }
  return { texts, between };
}

describe('SEC-033 criterion 3 (converter half): each supported language', () => {
  it('every language table entry is a literal of letters and hyphens, so none carries user text', () => {
    for (const [tag, entry] of Object.entries(LANGUAGES)) {
      for (const field of [entry.name, entry.ini, entry.tag]) {
        expect(field as string, `language ${tag}`).toMatch(/^[A-Za-z-]+$/);
      }
    }
  });

  it("a run marked with each tag gets that tag's \\DEdeflang line and a wrapper, and its hostile text is unchanged", async () => {
    const tags = Object.keys(LANGUAGES);
    expect(tags.length).toBe(33);
    for (const tag of tags) {
      const entry = LANGUAGES[tag]!;
      const docLang = tag === 'en-GB' ? 'de' : 'en-GB';
      const main = LANGUAGES[docLang]!;
      const check = async (vs: readonly string[]): Promise<void> => {
        const settings = { lang: docLang };
        const marked = (
          await run(
            doc(
              vs.map((v) => markedPara(v, tag)),
              { settings },
            ),
          )
        ).files['main.tex']!.split('\n');
        const ref = (
          await run(
            doc(
              vs.map((v) => markedPara(v, UNKNOWN_TAG)),
              { settings },
            ),
          )
        ).files['main.tex']!.split('\n');
        // The language setup: babel with the document language, then this tag once, from the table.
        expect(marked, tag).toContain(`\\DEbabel{${main.name as string}}{${main.ini as string}}`);
        expect(marked.filter((l) => l.startsWith('\\DEdeflang'))).toEqual([
          `\\DEdeflang{1}{${entry.name as string}}{${entry.ini as string}}{${entry.tag as string}}`,
        ]);
        expect(ref.some((l) => l.startsWith('\\DEbabel') || l.startsWith('\\DEdeflang'))).toBe(
          false,
        );
        // Apart from the setup lines and the wrapper, the file is the one written without a language.
        const unwrapped = marked
          .filter((l) => !l.startsWith('\\DEbabel') && !l.startsWith('\\DEdeflang'))
          .map((l) =>
            l.startsWith('\\DElang{1}{') && l.endsWith('}%')
              ? `${l.slice('\\DElang{1}{'.length, -2)}%`
              : l,
          );
        expect(unwrapped, tag).toEqual(ref);
        // Each wrapped run holds only the `text` emitter's escapes.
        const wrapped = marked.filter((l) => l.startsWith('\\DElang{'));
        expect(wrapped.length, tag).toBe(vs.length);
        for (const l of wrapped) {
          expect(l.startsWith('\\DElang{1}{'), tag).toBe(true);
          const { texts, between } = wrappedRuns(l);
          expect(between, l).toEqual([]);
          expect(texts.length, l).toBeGreaterThan(0);
          for (const x of texts) expectTextToken(x);
        }
      };
      await check(SEEDS.filter((s) => s.length > 0));
      await fc.assert(fc.asyncProperty(values, check), { numRuns: LANG_RUNS });
    }
  });

  it("a document in each language writes that tag's babel and PDF language, and nothing else changes", async () => {
    for (const tag of Object.keys(LANGUAGES)) {
      const entry = LANGUAGES[tag]!;
      const body = SEEDS.map((s) => para(s));
      const inLang = (await run(doc(body, { settings: { lang: tag, hyphenation: true } }))).files[
        'main.tex'
      ]!.split('\n');
      const inXx = (
        await run(doc(body, { settings: { lang: UNKNOWN_TAG, hyphenation: true } }))
      ).files['main.tex']!.split('\n');
      expect(inLang, tag).toContain(`\\DEbabel{${entry.name as string}}{${entry.ini as string}}`);
      expect(inXx).toContain('\\DEbabel{english}{en}');
      expect(inLang.length).toBe(inXx.length);
      const differing = inLang.filter((l, i) => l !== inXx[i]);
      for (const l of differing) {
        expect(
          l.startsWith('\\DEbabel{') || l.startsWith('\\DocumentMetadata{lang='),
          `${tag}: ${l}`,
        ).toBe(true);
      }
      const meta = inLang.find((l) => l.startsWith('\\DocumentMetadata{'));
      if (meta !== undefined) expect(meta).toContain(`lang=${entry.tag as string},`);
    }
  });

  it('a hostile language tag on a run or on the document writes nothing a known-unknown tag does not', async () => {
    const tagArb = fc
      .oneof(
        hostile,
        fc.constantFrom(
          'constructor',
          'toString',
          '__proto__',
          'hasOwnProperty',
          'en\\write18',
          'en-GB}',
          'de}\\def\\x{',
        ),
      )
      .filter((tag) => tag.length > 0 && tag !== UNKNOWN_TAG && !Object.hasOwn(LANGUAGES, tag));
    const refRun = (await run(doc([markedPara('Marked.', UNKNOWN_TAG)]))).files['main.tex'];
    const refDoc = (
      await run(doc([para('Text.')], { settings: { lang: UNKNOWN_TAG, hyphenation: true } }))
    ).files['main.tex'];
    await fc.assert(
      fc.asyncProperty(tagArb, async (tag) => {
        const onRun = await run(doc([markedPara('Marked.', tag)]));
        expect(onRun.files['main.tex']).toBe(refRun);
        expect(onRun.diagnostics.filter((d) => d.code === 'language_unknown')).toHaveLength(1);
        const onDoc = await run(
          doc([para('Text.')], { settings: { lang: tag, hyphenation: true } }),
        );
        expect(onDoc.files['main.tex']).toBe(refDoc);
        expect(onDoc.diagnostics.filter((d) => d.code === 'language_unknown')).toHaveLength(1);
      }),
      { numRuns: Math.max(20, Math.floor(RUNS / 4)) },
    );
  });
});
