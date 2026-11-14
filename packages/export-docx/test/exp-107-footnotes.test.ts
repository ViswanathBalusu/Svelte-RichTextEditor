/**
 * EXP-107, criterion 1 (footnotes of several paragraphs): every reference in the body or a story
 * to a note of more than one paragraph gets a report line of its own, preserved and not editable,
 * with a count and the blocks that hold it. The corpus holds no such note (checked below with an
 * independent reading of the XML parts), so the positive case is a synthetic package: one note of
 * `poi/footnotes.docx` gets a second paragraph.
 */
import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { importDocx, readZip, writeZip, type ZipWriteEntry } from '../src/index.ts';
import { corpusFiles, readFile } from './corpus.ts';

const KIND = 'footnote of several paragraphs';
const STORY_PART = /^word\/(document|header\d*|footer\d*)\.xml$/;
const enc = new TextEncoder();
const FOOTNOTES = corpusFiles().find((f) => f.name === 'poi/footnotes.docx')!;

/** The number of references to notes with more than one w:p, by a plain reading of the parts. */
function expectedCount(bytes: Uint8Array): number {
  const parts = unzipSync(bytes);
  const multi = new Set<string>();
  const notes = parts['word/footnotes.xml'];
  if (notes) {
    for (const chunk of strFromU8(notes)
      .split(/<w:footnote\b/)
      .slice(1)) {
      const id = /^[^>]*\bw:id="(-?\d+)"/.exec(chunk)?.[1];
      if (id !== undefined && (chunk.match(/<w:p[\s>]/g)?.length ?? 0) > 1) multi.add(id);
    }
  }
  let n = 0;
  for (const [name, data] of Object.entries(parts)) {
    if (!STORY_PART.test(name)) continue;
    for (const m of strFromU8(data).matchAll(/<w:footnoteReference\b[^>]*\bw:id="(-?\d+)"/g))
      if (multi.has(m[1]!)) n++;
  }
  return n;
}

/** The fixture with a second paragraph in its first real note. */
function twoParagraphNote(): Uint8Array {
  const zip = readZip(readFile(FOOTNOTES));
  const entries: ZipWriteEntry[] = zip.entries.map((e) => {
    if (e.name !== 'word/footnotes.xml') return { name: e.name, copyOf: e, from: zip };
    const xml = strFromU8(unzipSync(readFile(FOOTNOTES))['word/footnotes.xml']!);
    const start = xml.search(/<w:footnote\b[^>]*\bw:id="1"/);
    const end = xml.indexOf('</w:footnote>', start);
    expect(start).toBeGreaterThan(-1);
    const edited =
      xml.slice(0, end) +
      '<w:p><w:r><w:t>A second paragraph of the note.</w:t></w:r></w:p>' +
      xml.slice(end);
    return { name: e.name, data: enc.encode(edited), like: e };
  });
  return writeZip(entries);
}

describe('EXP-107 criterion 1: a footnote of several paragraphs gets a report line with a count', () => {
  it('the fixture without the edit has no such line, and the edited one has one, naming its block', async () => {
    const plain = await importDocx(readFile(FOOTNOTES));
    expect(plain.report.find((i) => i.kind === KIND)).toBeUndefined();

    const edited = twoParagraphNote();
    expect(expectedCount(edited)).toBe(1);
    const { report } = await importDocx(edited);
    const line = report.find((i) => i.kind === KIND);
    expect(line?.count).toBe(1);
    expect(line?.action).toBe('preserved');
    expect(line?.message).toMatch(/not editable/);
    expect(line?.blocks.length).toBeGreaterThan(0);
  });

  it('no file of the S11 corpus holds such a note, and the report agrees with a plain reading', async () => {
    const corpus = corpusFiles();
    for (const f of corpus) {
      const bytes = readFile(f);
      expect(expectedCount(bytes), f.name).toBe(0);
      const { report } = await importDocx(bytes);
      expect(
        report.find((i) => i.kind === KIND),
        f.name,
      ).toBeUndefined();
    }
  }, 120_000);
});
