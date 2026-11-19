/**
 * EXP-103 criterion 3: the tracked changes of a Word file, imported as suggestions, are accepted
 * and rejected like any other suggestion. The importer is `importDocx` of `@docedit/export-docx`
 * (reached by its source path: this package does not depend on it); the editor side is the real
 * core (`DocumentCore.resolveSuggestions`, FE-047), headless, as in the EXP-081 equivalence test.
 *
 * What is checked, on each corpus file that holds tracked changes:
 * - accepting every suggestion leaves no `ins` or `del` mark and the text of the document with
 *   its deletions applied and its insertions kept;
 * - rejecting every suggestion leaves no mark and the text with its insertions dropped and its
 *   deletions kept;
 * - resolving one suggestion by its identifier changes only that suggestion, and the others stay;
 * - resolving by the author's label (`word:<author>`) takes every suggestion of that author.
 */
import type { CdmEnvelope } from '@docedit/model';
import { DocumentCore } from '@docedit/engine/headless';
import { importDocx } from '../../export-docx/src/index.ts';
import { corpusFiles, readFile } from '../../export-docx/test/corpus.ts';
import { describe, expect, it } from 'vitest';

interface JsonNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: JsonNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

const FILES = [
  'docx4j/cr043-tracked.docx',
  'docx4j/review-for-word-word2010.docx',
  'docx4j/sample-docx.docx',
  'poi/delins.docx',
];

/** Every suggestion mark of a tree: on text and on blocks (`suggest`), in document order. */
function suggestionMarks(n: JsonNode, out: { type: string; id: string; user: string }[] = []) {
  const all = [...(n.marks ?? []), ...((n.attrs?.['suggest'] as JsonNode['marks']) ?? [])];
  for (const m of all)
    if (m.type === 'ins' || m.type === 'del')
      out.push({ type: m.type, id: String(m.attrs?.['id']), user: String(m.attrs?.['user']) });
  for (const c of n.content ?? []) suggestionMarks(c, out);
  return out;
}

/** The text of the tree with the runs of the given suggestion kinds left out. */
function textWithout(n: JsonNode, skip: (kind: string, id: string) => boolean): string {
  if (n.type === 'text') {
    const hidden = (n.marks ?? []).some(
      (m) => (m.type === 'ins' || m.type === 'del') && skip(m.type, String(m.attrs?.['id'])),
    );
    return hidden ? '' : (n.text ?? '');
  }
  const own = (n.attrs?.['suggest'] as JsonNode['marks']) ?? [];
  if (
    own.some((m) => (m.type === 'ins' || m.type === 'del') && skip(m.type, String(m.attrs?.['id'])))
  )
    return '';
  return (n.content ?? []).map((c) => textWithout(c, skip)).join('|');
}

/** Text runs and block text separated alike, with all separators and white space removed. */
const flat = (s: string): string => s.replace(/[\s|]+/g, '');

async function imported(name: string): Promise<CdmEnvelope> {
  const file = corpusFiles().find((f) => f.name === name)!;
  return (await importDocx(readFile(file))).envelope as unknown as CdmEnvelope;
}

function coreOf(env: CdmEnvelope): DocumentCore {
  return new DocumentCore({ doc: structuredClone(env), schedule: queueMicrotask });
}

describe('EXP-103 criterion 3: imported suggestions are resolved like any other', () => {
  for (const name of FILES) {
    it(`[${name}] accept all leaves the insertions and drops the deletions`, async () => {
      const env = await imported(name);
      const before = suggestionMarks(env.doc as unknown as JsonNode);
      expect(before.length, 'the file holds tracked changes').toBeGreaterThan(0);
      const core = coreOf(env);
      const report = core.resolveSuggestions('accept', 'document');
      const edited = core.getContent() as unknown as CdmEnvelope;
      core.destroy();
      expect(report.handled).toBeGreaterThan(0);
      expect(suggestionMarks(edited.doc as unknown as JsonNode)).toEqual([]);
      expect(flat(textWithout(edited.doc as unknown as JsonNode, () => false))).toBe(
        flat(textWithout(env.doc as unknown as JsonNode, (kind) => kind === 'del')),
      );
    });

    it(`[${name}] reject all drops the insertions and keeps the deletions`, async () => {
      const env = await imported(name);
      const core = coreOf(env);
      const report = core.resolveSuggestions('reject', 'document');
      const edited = core.getContent() as unknown as CdmEnvelope;
      core.destroy();
      expect(report.handled).toBeGreaterThan(0);
      expect(suggestionMarks(edited.doc as unknown as JsonNode)).toEqual([]);
      expect(flat(textWithout(edited.doc as unknown as JsonNode, () => false))).toBe(
        flat(textWithout(env.doc as unknown as JsonNode, (kind) => kind === 'ins')),
      );
    });
  }

  it('resolves one imported suggestion by its identifier and leaves the others', async () => {
    const env = await imported('docx4j/cr043-tracked.docx');
    const marks = suggestionMarks(env.doc as unknown as JsonNode);
    const ids = [...new Set(marks.map((m) => m.id))];
    expect(ids.length).toBeGreaterThan(1);
    const core = coreOf(env);
    core.resolveSuggestions('accept', 'document', undefined, ids[0]!);
    const left = suggestionMarks(core.getContent().doc as unknown as JsonNode);
    core.destroy();
    expect(left.some((m) => m.id === ids[0])).toBe(false);
    expect(new Set(left.map((m) => m.id))).toEqual(new Set(ids.slice(1)));
  });

  it('resolves every suggestion of one author label and leaves the others', async () => {
    const env = await imported('docx4j/review-for-word-word2010.docx');
    const marks = suggestionMarks(env.doc as unknown as JsonNode);
    const users = [...new Set(marks.map((m) => m.user))];
    expect(users.length, 'the file names more than one author').toBeGreaterThan(1);
    expect(users.every((u) => u.startsWith('word:'))).toBe(true);
    const core = coreOf(env);
    core.resolveSuggestions('accept', 'document', users[0]!);
    const left = suggestionMarks(core.getContent().doc as unknown as JsonNode);
    core.destroy();
    expect(left.some((m) => m.user === users[0])).toBe(false);
    expect(new Set(left.map((m) => m.user))).toEqual(new Set(users.slice(1)));
  });
});
