/**
 * EXP-100 criterion 3 without Word (the run against Word is exp-100-labels.word.test.ts): the
 * importer turns Word numbering into `numbering_def` nodes and paragraph `numbering`, the labels the
 * editor computes are the ones Word displayed for the corpus files below (read from Word on
 * 2026-11-26 with tools/word-layout/word-list-strings.ps1), a list written by the direct writer
 * reads back with the same labels, and the identifiers are fresh.
 */
import { describe, expect, it } from 'vitest';
import { computeLabels, styleTable, type JsonNode, type TreeNode } from '@docedit/model';
import { importDocx } from '../src/index.ts';
import { writeDocx } from '../src/writer.ts';
import { corpusFiles, readFile } from './corpus.ts';
import { writerDocs } from './writer-docs.ts';

const file = (name: string): Uint8Array => readFile(corpusFiles().find((f) => f.name === name)!);

/** The labels of the paragraphs of the body, in document order. */
function labelsOf(env: { doc: JsonNode }): string[] {
  const tree = env.doc as unknown as TreeNode;
  const labels = computeLabels(tree, { table: styleTable(tree) });
  const out: string[] = [];
  const walk = (n: JsonNode): void => {
    if (n.type === 'paragraph') {
      const l = labels.lists.get(String(n.attrs?.['id']));
      if (l && l.kind !== 'none') out.push(l.kind === 'bullet' ? '•' : l.text);
    }
    for (const c of n.content ?? []) walk(c);
  };
  walk(env.doc.content!.find((n) => n.type === 'body')!);
  return out;
}

const defsOf = (env: { doc: JsonNode }): JsonNode[] =>
  env.doc
    .content!.find((n) => n.type === 'defs')!
    .content!.filter((n) => n.type === 'numbering_def');

describe('Word numbering becomes numbering definitions and paragraph numbering (EXP-100)', () => {
  it('shows the labels Word showed for poi/ComplexNumberedLists.docx', async () => {
    const r = await importDocx(file('poi/ComplexNumberedLists.docx'));
    expect(labelsOf(r.envelope)).toEqual(
      '1. | 2. | a. | b. | c. | 3. | 4. | 1. | 2. | 3. | 10. | 11. | 12. | 13.'.split(' | '),
    );
    expect(defsOf(r.envelope).length).toBeGreaterThan(0);
  });

  it('numbers a style, as headings are, and shows what Word showed for docx4j/sample-docx.docx', async () => {
    const r = await importDocx(file('docx4j/sample-docx.docx'));
    expect(labelsOf(r.envelope)).toEqual(['•', '•', '1)', 'a)', 'i)']);
  });

  it('gives the definitions and lists fresh identifiers on each import, none taken from the file', async () => {
    const bytes = file('poi/ComplexNumberedLists.docx');
    const a = await importDocx(bytes);
    const b = await importDocx(bytes);
    const ids = (e: { doc: JsonNode }): string[] => {
      const out = defsOf(e).map((d) => String(d.attrs!['id']));
      const walk = (n: JsonNode): void => {
        const l = (n.attrs?.['numbering'] as { listId?: string } | null | undefined)?.listId;
        if (n.type === 'paragraph' && l) out.push(l);
        for (const c of n.content ?? []) walk(c);
      };
      walk(e.doc);
      return out;
    };
    const first = new Set(ids(a.envelope));
    expect(first.size).toBeGreaterThan(1);
    for (const id of ids(b.envelope)) expect(first.has(id)).toBe(false);
  });

  it('reads a list the direct writer wrote back with the same labels, restart included', async () => {
    const docs = await writerDocs();
    const d = docs.find((x) => x.name === 'numbering')!;
    const written = await writeDocx(d.envelope, d.assets);
    const back = await importDocx(written.bytes);
    expect(labelsOf(back.envelope)).toEqual(labelsOf(d.envelope));
    expect(labelsOf(d.envelope)).toEqual([
      'I',
      '1.',
      '1.a)',
      '•',
      '2.',
      '2.a)',
      'II',
      '1.',
      '5.',
      '6.',
    ]);
  });

  it('says what the grammar of the level text cannot hold', async () => {
    const r = await importDocx(file('poi/Numbering.docx'));
    expect(r.warnings.some((w) => w.startsWith('numbering: ') && w.includes('level text'))).toBe(
      true,
    );
    expect(
      r.warnings.some((w) => w.startsWith('numbering: ') && w.includes('becomes decimal')),
    ).toBe(true);
  });
});
