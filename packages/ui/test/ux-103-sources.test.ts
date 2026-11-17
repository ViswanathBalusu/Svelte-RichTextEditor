/**
 * The rules of the sources pane (UX-103; lane w3): the form's text and the attributes of a source,
 * the mapping of BibTeX and CSL-JSON entries (ADR 0365), and the plan of an import, which creates
 * no source whose key is a duplicate, is already in the document, or whose values fail the check.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { SourceSummary, SourceValues } from '../src/core-api.ts';
import { parseBibtex, parseCslJson } from '../src/shell/source-import.ts';
import {
  draftOf,
  entryToSource,
  importFormat,
  parsePeople,
  peopleText,
  planImport,
  valuesOf,
} from '../src/shell/sources.ts';

const BIB = `
@article{lovelace1843,
  author = {Lovelace, Ada and Charles Babbage and {The Analytical Society}},
  title = {Notes on the {Analytical} Engine},
  journal = {Scientific Memoirs},
  year = 1843, month = sep, volume = {3}, number = {2}, pages = {666--731},
  doi = {10.1000/notes.1843}, keywords = {engines}
}
@techreport{turing1936, author = "Turing, Alan", title = "On computable numbers",
  year = "1936", number = "TR-42", institution = "Cambridge"}
@book{Turing1936, title = {A second entry with the same key}}
@misc{bad key!, title = {x}}
`;

const noProblems = (): readonly string[] => [];

describe('the form and the attributes of a source (UX-103)', () => {
  it('reads people as family and given names, or as one literal name', () => {
    expect(parsePeople('Lovelace, Ada; Babbage, Charles; The Analytical Society')).toEqual([
      { family: 'Lovelace', given: 'Ada' },
      { family: 'Babbage', given: 'Charles' },
      { literal: 'The Analytical Society' },
    ]);
    expect(parsePeople('  ;  ')).toBeNull();
  });

  it('people written by the form are read back the same (property)', () => {
    const word = fc.stringMatching(/^[A-Za-z][A-Za-z '-]{0,12}[A-Za-z]$/);
    const person = fc.oneof(fc.record({ family: word, given: word }), fc.record({ literal: word }));
    fc.assert(
      fc.property(fc.array(person, { minLength: 1, maxLength: 6 }), (people) => {
        expect(parsePeople(peopleText(people))).toEqual(people);
      }),
    );
  });

  it('an empty field is an attribute that is not set, and a draft of a source saves unchanged', () => {
    const source: SourceSummary = {
      id: 'smith2026',
      values: {
        kind: 'article-journal',
        title: 'A title',
        authors: [{ family: 'Smith', given: 'Jo' }],
        issued: '2026-11',
        containerTitle: null,
        doi: null,
        url: 'https://example.org/a',
      },
      citedAt: [],
    };
    expect(valuesOf(draftOf(source))).toEqual(source.values);
  });
});

describe('the mapping of imported entries (UX-103 criterion 3; ADR 0365)', () => {
  it('maps a BibTeX article onto the attributes of a source', () => {
    const [entry] = parseBibtex(BIB).entries;
    const mapped = entryToSource(entry!, 'bibtex');
    expect(mapped.id).toBe('lovelace1843');
    expect(mapped.values).toEqual({
      kind: 'article-journal',
      authors: [
        { family: 'Lovelace', given: 'Ada' },
        { family: 'Babbage', given: 'Charles' },
        { literal: 'The Analytical Society' },
      ],
      title: 'Notes on the Analytical Engine',
      containerTitle: 'Scientific Memoirs',
      issued: '1843-09',
      volume: '3',
      issue: '2',
      pages: '666-731',
      doi: '10.1000/notes.1843',
    });
    // A field no attribute takes is named, not stored under another name.
    expect(mapped.dropped).toEqual(['keywords']);
  });

  it('maps the number of a report to `number`, and names the fields it leaves out', () => {
    const mapped = entryToSource(parseBibtex(BIB).entries[1]!, 'bibtex');
    expect(mapped.values).toMatchObject({ kind: 'report', number: 'TR-42', issued: '1936' });
    expect(mapped.dropped).toEqual(['institution']);
  });

  it('maps a CSL-JSON item, with its dates and names', () => {
    const csl = JSON.stringify([
      {
        id: 'hopper1952',
        type: 'paper-conference',
        title: 'The education of a computer',
        author: [{ family: 'Hopper', given: 'Grace' }],
        issued: { 'date-parts': [[1952, 5, 2]] },
        'container-title': 'Proceedings of the ACM',
        DOI: '10.1145/609784.609818',
        page: '243-249',
        abstract: 'left out',
      },
    ]);
    const mapped = entryToSource(parseCslJson(csl).entries[0]!, 'csl');
    expect(mapped.values).toEqual({
      kind: 'paper-conference',
      title: 'The education of a computer',
      authors: [{ family: 'Hopper', given: 'Grace' }],
      issued: '1952-05-02',
      containerTitle: 'Proceedings of the ACM',
      doi: '10.1145/609784.609818',
      pages: '243-249',
    });
    expect(mapped.dropped).toEqual(['abstract']);
  });

  it('reads a file as CSL-JSON or BibTeX by its name, then by its content', () => {
    expect(importFormat('refs.json', '')).toBe('csl');
    expect(importFormat('refs.bib', '[')).toBe('bibtex');
    expect(importFormat('refs.txt', ' [{"id":"a"}]')).toBe('csl');
    expect(importFormat('refs.txt', '@book{a,}')).toBe('bibtex');
  });
});

describe('the plan of an import (UX-103 criterion 3)', () => {
  it('reports duplicate keys, keys the document has and values that fail, and adds the rest', () => {
    const parsed = parseBibtex(BIB);
    // `turing1936` and `Turing1936` are one key (compared without case): neither is created.
    const check = (id: string, values: SourceValues): readonly string[] =>
      values['doi'] === '10.1000/notes.1843' && id === 'never' ? ['doi'] : [];
    const plan = planImport(parsed, 'bibtex', [], check);
    expect(plan.add.map((s) => s.id)).toEqual(['lovelace1843']);
    expect(plan.refused.map((r) => [r.key, r.reason])).toEqual([
      ['turing1936', 'duplicate'],
      ['Turing1936', 'duplicate'],
    ]);
    // The entry with a key the grammar of BibTeX refuses is a parser problem, with its line.
    expect(plan.problems.length).toBeGreaterThan(0);

    const again = planImport(parsed, 'bibtex', ['Lovelace1843'], noProblems);
    expect(again.add).toEqual([]);
    expect(again.refused[0]).toMatchObject({ key: 'lovelace1843', reason: 'exists' });

    const failing = planImport(parsed, 'bibtex', [], () => ['doi', 'issued']);
    expect(failing.add).toEqual([]);
    expect(failing.refused[0]).toMatchObject({
      key: 'lovelace1843',
      reason: 'invalid',
      fields: ['doi', 'issued'],
    });
  });

  it('never plans two sources with one key, nor one the document has (property)', () => {
    const key = fc.constantFrom('a1', 'A1', 'b2', 'c3', 'C3', 'd4');
    fc.assert(
      fc.property(
        fc.array(key, { maxLength: 8 }),
        fc.array(key, { maxLength: 3 }),
        (keys, existing) => {
          const text = keys.map((k) => `@book{${k}, title = {T}}`).join('\n');
          const plan = planImport(parseBibtex(text), 'bibtex', existing, noProblems);
          const added = plan.add.map((s) => s.id.toLowerCase());
          expect(new Set(added).size).toBe(added.length);
          const have = new Set(existing.map((k) => k.toLowerCase()));
          expect(added.filter((k) => have.has(k))).toEqual([]);
          // Every entry is either added or reported.
          expect(plan.add.length + plan.refused.length).toBe(keys.length);
        },
      ),
    );
  });
});
