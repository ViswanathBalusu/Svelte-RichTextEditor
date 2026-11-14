/**
 * EXP-046 criterion 5 (Node.js only): a failing input is stored as a fixture of the emitter corpus,
 * and every stored fixture is replayed through the grammar checks of the string emitters on every run.
 *
 * - The corpus folder is `test/emitter-corpus/` in this package. The shared `corpus` package is not
 *   in this lane, so the location is a proposal (ADR 0143, item 3).
 * - A fixture is `{ "emitter": <name>, "input": <string> }`, one JSON file per input, named by the
 *   first 16 hex digits of the SHA-256 of the emitter and the input.
 * - No failure has been found, so the folder holds no fixture yet. The replay test then checks only
 *   the folder's format and the store helper, and says so. Criterion 5 stays unticked until a failure
 *   is found and stored.
 *
 * The grammar checks repeat those of `emit.fuzz.test.ts` (which does not export them).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { clean, pdfString, kvValue, text, url } from './emit.ts';

const CORPUS_EMITTERS = ['text', 'pdfString', 'kvValue', 'url'] as const;
type CorpusEmitter = (typeof CORPUS_EMITTERS)[number];

interface CorpusFixture {
  emitter: CorpusEmitter;
  input: string;
}

const CORPUS_DIR = fileURLToPath(new URL('../test/emitter-corpus/', import.meta.url));

/** Writes one fixture; the file name is derived from the emitter and the input, so no duplicate is stored twice. */
function storeFixture(dir: string, fixture: CorpusFixture): string {
  const digest = createHash('sha256')
    .update(`${fixture.emitter}\0${fixture.input}`, 'utf8')
    .digest('hex');
  const path = join(dir, `${fixture.emitter}-${digest.slice(0, 16)}.json`);
  writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
  return path;
}

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

  it('replays every fixture in test/emitter-corpus/ (none stored yet, so this checks the format only)', () => {
    for (const path of corpusFiles(CORPUS_DIR)) {
      const fixture = readFixture(path);
      expect(problems(fixture), path).toEqual([]);
    }
  });
});
