/**
 * EXP-046 criterion 5 (Node.js only): a failing input is stored as a fixture of the emitter corpus,
 * and every stored fixture is replayed through the grammar checks of the string emitters on every run.
 *
 * - The corpus folder is `test/emitter-corpus/` in this package (ADR 0143, item 3: the shared
 *   `corpus` package holds documents, so the folder stays here).
 * - A fixture is `{ "emitter": <name>, "input": <string> }`, one JSON file per input, named by the
 *   first 16 hex digits of the SHA-256 of the emitter and the input (`test/emitter-corpus.ts`).
 * - The store is automatic: `assertStoring` runs a fuzz property, and on a failure writes the shrunk
 *   counterexample as a fixture before it reports the failure. `emit.fuzz.test.ts` runs its string
 *   properties through it, and `emit.compile.fuzz.test.ts` stores the strings the compile lost.
 * - No failure has been found, so the folder holds no fixture yet. The replay test then checks the
 *   folder's format, and the store is tested here with a property that fails on purpose, in a
 *   temporary folder.
 *
 * The grammar checks repeat those of `emit.fuzz.test.ts` (which does not export them).
 */
import fc from 'fast-check';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clean, pdfString, kvValue, text, url } from './emit.ts';
import {
  assertStoring,
  CORPUS_DIR,
  CORPUS_EMITTERS,
  storeFixture,
  type CorpusEmitter,
  type CorpusFixture,
} from '../test/emitter-corpus.ts';

/** Reads one fixture and rejects a file that does not have the format. */
function readFixture(path: string): CorpusFixture {
  const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof data !== 'object' || data === null) throw new Error(`${path}: not an object`);
  const { emitter, input } = data as Record<string, unknown>;
  if (!CORPUS_EMITTERS.includes(emitter as CorpusEmitter))
    throw new Error(`${path}: unknown emitter ${String(emitter)}`);
  if (typeof input !== 'string') throw new Error(`${path}: input is not a string`);
  return { emitter: emitter as CorpusEmitter, input };
}

function corpusFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => join(dir, name));
}

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
const SPECIALS = '\\{}$&#_%^~';
const TOKEN =
  /\\textbackslash\{\}|\\textasciicircum\{\}|\\textasciitilde\{\}|\{\[\}|\{\]\}|\\[{}$&#_%\- ]|~|[\s\S]/g;

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

/** Returns the problems with one fixture; an empty list means it passes. */
function problems(f: CorpusFixture): string[] {
  switch (f.emitter) {
    case 'text': {
      const back = unescapeText(text(f.input));
      if (back === null) return ['text: a bare special character or backslash survives'];
      return back === clean(f.input)
        ? []
        : ['text: the output does not read back to the cleaned input'];
    }
    case 'pdfString': {
      const p = pdfString(f.input);
      if (!/^\\DEstr\{(?:[0-9A-F]{2})*\}$/.test(p))
        return ['pdfString: not hexadecimal digits in \\DEstr'];
      return decodeHex(/^\\DEstr\{((?:[0-9A-F]{2})*)\}$/.exec(p)![1]!) === clean(f.input)
        ? []
        : ['pdfString: the hex does not decode to the cleaned input'];
    }
    case 'kvValue': {
      const p = pdfString(f.input);
      return kvValue(f.input) === `{${p}}` ? [] : ['kvValue: not the braced pdfString form'];
    }
    case 'url': {
      const r = url(f.input);
      if (r.kind === 'external') {
        if (!/^(?:[0-9A-F]{2})*$/.test(r.tex))
          return ['url: external target is not hexadecimal digits'];
        return /^(?:https?:\/\/|mailto:)/i.test(decodeHex(r.tex))
          ? []
          : ['url: external target has no allowed scheme'];
      }
      if (r.kind === 'internal')
        return /^[A-Za-z0-9_:.-]{1,128}$/.test(r.name)
          ? []
          : ['url: internal name is not a plain name'];
      return /^(?:https?:\/\/|mailto:)/i.test(f.input)
        ? ['url: an allowed scheme was refused']
        : [];
    }
  }
}

describe('EXP-046 criterion 5: stored failures are replayed', () => {
  it('a stored fixture reads back and replays through the checks (mechanism test)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'emit-corpus-'));
    try {
      // A probe with the attack forms that the emitters must neutralise; it passes, so nothing is reported.
      const probe: CorpusFixture = { emitter: 'text', input: '\\input{/etc/passwd}}%^^5c' };
      const path = storeFixture(dir, probe);
      expect(readFixture(path)).toEqual(probe);
      expect(problems(readFixture(path))).toEqual([]);
      // The same input under the same emitter gets the same name, so a second store does not add a file.
      expect(storeFixture(dir, probe)).toBe(path);
      expect(readdirSync(dir)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a failing fuzz property stores its shrunk counterexample as a fixture, and the error names the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'emit-corpus-store-'));
    try {
      // A property that fails on purpose: any string with a `%` fails, and the example `ab%cd` is shrunk.
      let message = '';
      try {
        assertStoring(
          'text',
          fc.property(fc.string({ minLength: 1, maxLength: 12 }), (v) => !v.includes('%')),
          { seed: 46, numRuns: 400, examples: [['ab%cd']] },
          ([v]) => v,
          dir,
        );
      } catch (e) {
        message = String(e);
      }
      expect(message).toMatch(/Stored as an emitter-corpus fixture: /);
      const files = readdirSync(dir);
      expect(files).toHaveLength(1);
      expect(message).toContain(files[0]!);
      const stored = readFixture(join(dir, files[0]!));
      expect(stored.emitter).toBe('text');
      // The input is the failing one, and it was shrunk from the 5-character example.
      expect(stored.input).toContain('%');
      expect(stored.input.length).toBeLessThan(5);
      // A property that holds stores nothing.
      const clear = mkdtempSync(join(tmpdir(), 'emit-corpus-clear-'));
      try {
        assertStoring(
          'text',
          fc.property(fc.string(), () => true),
          { numRuns: 20 },
          ([v]) => v,
          clear,
        );
        expect(readdirSync(clear)).toEqual([]);
      } finally {
        rmSync(clear, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a fixture with an emitter outside the string emitters or a non-string input', () => {
    const dir = mkdtempSync(join(tmpdir(), 'emit-corpus-bad-'));
    try {
      writeFileSync(
        join(dir, 'bad-emitter.json'),
        JSON.stringify({ emitter: 'color', input: 'x' }),
        'utf8',
      );
      writeFileSync(
        join(dir, 'bad-input.json'),
        JSON.stringify({ emitter: 'text', input: 7 }),
        'utf8',
      );
      expect(() => readFixture(join(dir, 'bad-emitter.json'))).toThrow(/unknown emitter/);
      expect(() => readFixture(join(dir, 'bad-input.json'))).toThrow(/not a string/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('replays every fixture in test/emitter-corpus/ (none is stored yet, so this checks the format of the folder)', () => {
    for (const path of corpusFiles(CORPUS_DIR)) {
      const fixture = readFixture(path);
      expect(problems(fixture), path).toEqual([]);
    }
  });
});
