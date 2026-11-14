/**
 * Import of BibTeX and CSL-JSON sources (UX-103 criterion 3): the grammar is checked, problems
 * are reported with their place, later entries still import after a bad one, and duplicate keys
 * are reported. Property tests generate well-formed files and check the round trip.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseBibtex, parseCslJson } from '../src/shell/source-import.ts';

const TYPES = ['article', 'book', 'misc', 'inproceedings'] as const;
const FIELDS = ['title', 'author', 'year', 'doi', 'journal'] as const;

const value = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 ,.:;-]{0,24}$/);

interface Sample {
  type: string;
  key: string;
  fields: [string, string][];
}

const entryArb = fc.record({
  type: fc.constantFrom(...TYPES),
  fields: fc.uniqueArray(fc.tuple(fc.constantFrom(...FIELDS), value), {
    selector: ([name]) => name,
    minLength: 1,
    maxLength: 4,
  }),
});

/** A file of entries with distinct keys, written in BibTeX. */
const fileArb = fc
  .array(entryArb, { minLength: 1, maxLength: 6 })
  .map((list): { text: string; samples: Sample[] } => {
    const samples = list.map((e, i) => ({ type: e.type, key: `key${i}`, fields: e.fields }));
    const text = samples
      .map(
        (s) =>
          `@${s.type}{${s.key},\n` +
          s.fields.map(([n, v]) => `  ${n} = {${v}},`).join('\n') +
          '\n}\n',
      )
      .join('\n');
    return { text, samples };
  });

describe('BibTeX import: well-formed files (UX-103 criterion 3)', () => {
  it('reads back every generated entry with its type, key and field values', () => {
    fc.assert(
      fc.property(fileArb, ({ text, samples }) => {
        const result = parseBibtex(text);
        expect(result.problems).toEqual([]);
        expect(result.duplicates).toEqual([]);
        expect(result.entries.map((e) => [e.type, e.key, e.fields])).toEqual(
          samples.map((s) => [s.type, s.key, Object.fromEntries(s.fields)]),
        );
      }),
    );
  });

  it('gives each entry the line where it starts', () => {
    fc.assert(
      fc.property(fileArb, ({ text }) => {
        const result = parseBibtex(text);
        for (const e of result.entries) {
          const line = text.split('\n')[e.at - 1] ?? '';
          expect(line.startsWith(`@${e.type}{`)).toBe(true);
        }
      }),
    );
  });

  it('skips comment, string and preamble blocks without a problem', () => {
    const text =
      '@comment{free text with @ inside}\n@string{x = "y"}\n@preamble{"p"}\n@book{b1, title = x # {tail}}\n';
    const result = parseBibtex(text);
    expect(result.problems).toEqual([]);
    // A macro name and a braced part are joined with # as written: the macro is not expanded here.
    expect(result.entries.map((e) => [e.key, e.fields['title']])).toEqual([['b1', 'xtail']]);
  });
});

describe('BibTeX import: problems are reported and do not stop the file', () => {
  it('reports an entry that is not closed and still imports the next one', () => {
    const text = '@article{a, title = {x}\n\n@book{b, title = {y}}\n';
    const result = parseBibtex(text);
    expect(result.entries.map((e) => e.key)).toEqual(['b']);
    expect(result.problems).toEqual([expect.objectContaining({ at: 1 })]);
  });

  it('reports a field without a value and a missing equals sign', () => {
    const missingValue = parseBibtex(
      '@article{a, title = , year = {1999}}\n@book{b, title = {t}}\n',
    );
    expect(missingValue.problems.map((p) => p.at)).toEqual([1]);
    expect(missingValue.entries.map((e) => e.key)).toEqual(['b']);
    const missingEquals = parseBibtex('@misc{c, title {t}}\n');
    expect(missingEquals.problems[0]?.message).toMatch(/'='/);
  });

  it('keeps the first of two fields with the same name and reports the second', () => {
    const result = parseBibtex('@article{a,\n  year = {1999},\n  year = {2000}\n}\n');
    expect(result.entries[0]?.fields['year']).toBe('1999');
    expect(result.problems).toEqual([expect.objectContaining({ at: 1 })]);
  });

  it('never throws on arbitrary text and reports places inside the file', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (text) => {
        const lines = text.split('\n').length;
        const result = parseBibtex(text);
        for (const p of result.problems) {
          expect(p.at).toBeGreaterThanOrEqual(1);
          expect(p.at).toBeLessThanOrEqual(lines);
        }
      }),
    );
  });
});

describe('duplicate keys are reported (UX-103 criterion 3)', () => {
  it('reports a key used twice, whatever the case of the second use', () => {
    const text =
      '@article{Smith2001, title = {a}}\n@book{other, title = {b}}\n@misc{smith2001, title = {c}}\n';
    const result = parseBibtex(text);
    expect(result.duplicates).toEqual([{ key: 'Smith2001', at: [1, 3] }]);
  });

  it('reports every generated duplicate and no unique key', () => {
    fc.assert(
      fc.property(fileArb, fc.nat(), ({ text, samples }, n) => {
        const dup = samples[n % samples.length]!;
        const again = `@misc{${dup.key.toUpperCase()}, title = {again}}\n`;
        const result = parseBibtex(`${text}\n${again}`);
        expect(result.duplicates.map((d) => d.key)).toEqual([dup.key]);
        expect(result.duplicates[0]?.at.length).toBe(2);
      }),
    );
  });
});

describe('CSL-JSON import (UX-103 criterion 3)', () => {
  it('imports objects with an id and a type, and reports the others by position', () => {
    const text = JSON.stringify([
      { id: 'a1', type: 'article-journal', title: 'T', author: [{ family: 'X' }] },
      { type: 'book' },
      { id: 'a2' },
      'not an object',
      { id: 'a1', type: 'book' },
    ]);
    const result = parseCslJson(text);
    expect(result.entries.map((e) => [e.key, e.type, e.at])).toEqual([
      ['a1', 'article-journal', 1],
      ['a1', 'book', 5],
    ]);
    expect(result.entries[0]?.fields['author']).toBe('[{"family":"X"}]');
    expect(result.problems.map((p) => p.at)).toEqual([2, 3, 4]);
    expect(result.duplicates).toEqual([{ key: 'a1', at: [1, 5] }]);
  });

  it('reports a file that is not JSON or not an array, and imports nothing', () => {
    expect(parseCslJson('{ nope').entries).toEqual([]);
    expect(parseCslJson('{ nope').problems).toHaveLength(1);
    expect(parseCslJson('{"id":"a","type":"book"}').problems[0]?.message).toMatch(/array/);
  });

  it('never throws on arbitrary text', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (text) => {
        const result = parseCslJson(text);
        for (const p of result.problems) expect(p.at).toBeGreaterThanOrEqual(1);
        for (const e of result.entries) expect(typeof e.key).toBe('string');
      }),
    );
  });
});
