/**
 * EXP-103 over the S11 corpus files that hold tracked changes (corpus/SOURCES.md). Criterion 1:
 * insertions and deletions become `ins` and `del` marks with fresh suggestion identifiers, one
 * revision per identifier. Criterion 2 (authors become labels) is tested for its label form only:
 * whether a label can never match a real user is a question for the authority, so criterion 2 stays
 * open. Criterion 4: the import creates no grants and no workflow state, so no user gains the
 * `suggest` capability from it (the package side; the authority reads grants, and none exist).
 */
import { describe, expect, it } from 'vitest';
import type { JsonNode, JsonMark } from '@docedit/model';
import { importDocx } from '../src/index.ts';
import { corpusFiles, readFile } from './corpus.ts';

const FILES = [
  'docx4j/cr043-tracked.docx',
  'docx4j/review-for-word-word2010.docx',
  'docx4j/sample-docx.docx',
  'poi/delins.docx',
] as const;

const corpus = new Map(corpusFiles().map((f) => [f.name, f]));

interface Found {
  mark: JsonMark;
}

/** Every suggestion mark of the document, on text, on inline atoms and on rows. */
function suggestionMarks(doc: JsonNode): Found[] {
  const out: Found[] = [];
  const stack: JsonNode[] = [doc];
  while (stack.length) {
    const n = stack.pop()!;
    for (const m of n.marks ?? []) if (m.type === 'ins' || m.type === 'del') out.push({ mark: m });
    for (const c of n.content ?? []) stack.push(c);
  }
  return out;
}

async function importNamed(name: string) {
  const file = corpus.get(name);
  if (!file) throw new Error(`missing corpus file ${name}`);
  return importDocx(readFile(file));
}

describe('criterion 1: insertions and deletions become ins and del marks with fresh identifiers', () => {
  it.each(FILES)('%s has suggestion marks of both kinds it holds', async (name) => {
    const { envelope } = await importNamed(name);
    const types = new Set(suggestionMarks(envelope.doc as JsonNode).map((f) => f.mark.type));
    expect(types.size, `kinds in ${name}`).toBeGreaterThan(0);
  });

  it('holds both insertions and deletions in the two files that have both', async () => {
    for (const name of ['docx4j/cr043-tracked.docx', 'docx4j/review-for-word-word2010.docx']) {
      const { envelope } = await importNamed(name);
      const types = new Set(suggestionMarks(envelope.doc as JsonNode).map((f) => f.mark.type));
      expect(types, name).toEqual(new Set(['ins', 'del']));
    }
  });

  it.each(FILES)(
    '%s: each identifier names one revision, with a random identifier',
    async (name) => {
      const { envelope } = await importNamed(name);
      const byId = new Map<string, JsonMark>();
      for (const { mark } of suggestionMarks(envelope.doc as JsonNode)) {
        const id = mark.attrs?.['id'];
        expect(typeof id, 'id is a string').toBe('string');
        const key = id as string;
        // Random identifiers, never the digits a file gives its revisions (w:id).
        expect(key).toMatch(/^[A-Za-z0-9_-]{8,}$/);
        expect(key).not.toMatch(/^[0-9]+$/);
        const seen = byId.get(key);
        if (seen) {
          // Several marks may share one identifier (a revision spanning runs), but only one kind
          // and one label.
          expect(seen.type, `kind of ${key}`).toBe(mark.type);
          expect(seen.attrs?.['user'], `label of ${key}`).toBe(mark.attrs?.['user']);
        } else byId.set(key, mark);
      }
      expect(byId.size).toBeGreaterThan(0);
    },
  );

  it.each(FILES)(
    '%s: a second import shares no suggestion identifier with the first',
    async (name) => {
      const ids = async () =>
        new Set(
          suggestionMarks((await importNamed(name)).envelope.doc as JsonNode).map(
            (f) => f.mark.attrs?.['id'] as string,
          ),
        );
      const first = await ids();
      const second = await ids();
      expect(first.size).toBeGreaterThan(0);
      for (const id of first) expect(second.has(id), `shared id ${id}`).toBe(false);
    },
  );
});

describe('criterion 2 (label form only): an author becomes a label, never a bare identity', () => {
  it.each(FILES)('%s: every label is the author with the word: prefix', async (name) => {
    const { envelope } = await importNamed(name);
    for (const { mark } of suggestionMarks(envelope.doc as JsonNode)) {
      const user = mark.attrs?.['user'];
      expect(typeof user).toBe('string');
      expect(user as string).toMatch(/^word:.+/);
      expect((user as string).length).toBeLessThanOrEqual(255);
    }
  });

  it('keeps the author name of cr043-tracked.docx in its label', async () => {
    const { envelope } = await importNamed('docx4j/cr043-tracked.docx');
    const labels = new Set(
      suggestionMarks(envelope.doc as JsonNode).map((f) => f.mark.attrs?.['user']),
    );
    expect(labels.has('word:Author A')).toBe(true);
  });
});

describe('criterion 4: the import gives no user the suggest capability (no grants, no workflow)', () => {
  it.each(FILES)('%s: the envelope holds no grants and no regions', async (name) => {
    const { envelope } = await importNamed(name);
    expect(Object.keys(envelope).sort()).toEqual(['cdm', 'doc', 'requires']);
    const stack: unknown[] = [envelope.doc];
    while (stack.length) {
      const n = stack.pop();
      if (Array.isArray(n)) stack.push(...n);
      else if (n && typeof n === 'object') {
        const o = n as Record<string, unknown>;
        expect(o['type'], 'no region node').not.toBe('region');
        expect(Object.keys(o)).not.toContain('grants');
        for (const v of Object.values(o)) stack.push(v);
      }
    }
  });
});
