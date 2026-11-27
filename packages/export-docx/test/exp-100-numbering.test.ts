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
import { levelText } from '../src/import-numbering.ts';
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

  it('keeps the letters of a level text and the Greek sequence of poi/Numbering.docx (owner decision 240)', async () => {
    const r = await importDocx(file('poi/Numbering.docx'));
    const levels = defsOf(r.envelope).flatMap(
      (d) => d.attrs!['levels'] as Array<{ format: string; text: string }>,
    );
    expect(levels.map((l) => l.text)).toContain('NEW-%1-FORMAT');
    expect(levels.some((l) => l.format === 'lowerGreek' && l.text === '%1.')).toBe(true);
    // Nothing in this file is cut or turned into decimal any more.
    expect(
      r.warnings.filter(
        (w) => w.startsWith('numbering: ') && (w.includes('level text') || w.includes('decimal')),
      ),
    ).toEqual([]);
    const labels = labelsOf(r.envelope);
    expect(labels).toContain('NEW-1-FORMAT');
    expect(labels.some((l) => /^[α-ω]\.$/u.test(l))).toBe(true);
  });

  it('reads a level text as the grammar holds it: placeholders and text, no percent sign or control', () => {
    expect(levelText('Article %1')).toBe('Article %1');
    expect(levelText('第%1条 §%2.%3')).toBe('第%1条 §%2.%3');
    expect(levelText('100% of %1\u0007')).toBe('100 of %1');
    expect(levelText('%')).toBe('');
    expect(levelText('{a}\\b‮')).toBe('ab');
    expect(levelText('a'.repeat(100))).toBe('a'.repeat(64));
    // A placeholder is never cut in half at the limit.
    expect(levelText(`${'a'.repeat(63)}%1`)).toBe('a'.repeat(63));
  });

  it('writes literal text and the Greek format of a level, and reads them back with the same labels', async () => {
    const docs = await writerDocs();
    const d = docs.find((x) => x.name === 'numbering')!;
    const outline = defsOf(d.envelope).find((n) => n.attrs!['id'] === 'Outline')!;
    const levels = outline.attrs!['levels'] as Array<Record<string, unknown>>;
    levels[0] = { ...levels[0]!, format: 'lowerGreek', text: 'Article %1 §' };
    levels[1] = { ...levels[1]!, text: 'NEW-%1-FORMAT %2)' };
    const before = labelsOf(d.envelope);
    expect(before.slice(1, 4)).toEqual(['Article α §', 'NEW-α-FORMAT a)', '•']);
    const written = await writeDocx(d.envelope, d.assets);
    const back = await importDocx(written.bytes);
    expect(labelsOf(back.envelope)).toEqual(before);
    expect(
      back.warnings.filter(
        (w) => w.startsWith('numbering: ') && (w.includes('level text') || w.includes('decimal')),
      ),
    ).toEqual([]);
  });
});
