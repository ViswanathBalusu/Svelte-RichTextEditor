/**
 * EXP-101, criterion 1 (row spans): `w:vMerge` becomes the `rowspan` of the restart cell. A
 * continuation cell with no content leaves the model's row and stays in the source map's gap, so an
 * unedited table is written back as it was (A2). A continuation cell with content or a tracked
 * change is not merged. The direct writer writes a row span back as a restart and continuation cells.
 */
import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { type JsonNode } from '@docedit/model';
import { validate } from '@docedit/model/validate';
import {
  checkR0,
  exportDocx,
  importDocx,
  readZip,
  writeZip,
  type ZipWriteEntry,
} from '../src/index.ts';
import { AssetStore } from '../src/assets.ts';
import { writeDocx } from '../src/writer.ts';
import { corpusFiles, readFile } from './corpus.ts';

const enc = new TextEncoder();
const BASE = corpusFiles().find((f) => f.name === 'poi/footnotes.docx')!;

function tables(doc: JsonNode): JsonNode[] {
  const out: JsonNode[] = [];
  const stack: JsonNode[] = [doc];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === 'table') out.push(n);
    for (const c of n.content ?? []) stack.push(c);
  }
  return out;
}

const cellsOf = (t: JsonNode): JsonNode[] => (t.content ?? []).flatMap((r) => r.content ?? []);

/** The number of `w:vMerge` elements with no `restart` value, by a plain reading of the XML. */
function continuationCount(bytes: Uint8Array): number {
  const xml = strFromU8(unzipSync(bytes)['word/document.xml']!);
  return [...xml.matchAll(/<w:vMerge\b([^>]*)\/?>/g)].filter((m) => !/w:val="restart"/.test(m[1]!))
    .length;
}

const tc = (merge: string, body: string): string =>
  `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/>${merge}</w:tcPr>${body}</w:tc>`;
const p = (text = ''): string => (text ? `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>` : '<w:p/>');
const plain = tc('', p('x'));

/** A package whose body is one table of two columns, from the given rows of cells. */
function packageWith(rows: string[][]): Uint8Array {
  const zip = readZip(readFile(BASE));
  const table =
    '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>' +
    '<w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>' +
    rows.map((r) => `<w:tr>${r.join('')}</w:tr>`).join('') +
    '</w:tbl><w:p/>';
  const entries: ZipWriteEntry[] = zip.entries.map((e) => {
    if (e.name !== 'word/document.xml') return { name: e.name, copyOf: e, from: zip };
    const xml = strFromU8(unzipSync(readFile(BASE))['word/document.xml']!);
    const edited = xml.replace(/<w:body>[\s\S]*<\/w:body>/, `<w:body>${table}</w:body>`);
    expect(edited).not.toBe(xml);
    return { name: e.name, data: enc.encode(edited), like: e };
  });
  return writeZip(entries);
}

describe('EXP-101 criterion 1: vertical merges become row spans', () => {
  it('corpus: continuation cells are absorbed into row spans, and an unedited file is written back as it was', async () => {
    let spanned = 0;
    for (const name of [
      'docx4j/tables.docx',
      'docx4j/sample-docx.docx',
      'python-docx/tbl-cell-access.docx',
    ]) {
      const file = corpusFiles().find((f) => f.name === name)!;
      const bytes = readFile(file);
      const imported = await importDocx(bytes);
      const doc = imported.envelope.doc as JsonNode;
      const absorbed = tables(doc)
        .flatMap(cellsOf)
        .reduce((s, c) => s + Number(c.attrs?.['rowspan'] ?? 1) - 1, 0);
      expect(absorbed, name).toBeGreaterThan(0);
      expect(absorbed, name).toBeLessThanOrEqual(continuationCount(bytes));
      spanned += absorbed;
      expect(validate(imported.envelope, { attachedAssets: imported.assets.ids() }).valid).toBe(
        true,
      );
      const out = await exportDocx(imported.envelope, bytes, imported.sourceMap, imported.assets);
      expect(checkR0(bytes, out.bytes).diff.changed, name).toEqual([]);
    }
    expect(spanned).toBeGreaterThan(0);
  });

  it('a restart cell takes the row span of the empty continuation cells below it, and the row is shorter', async () => {
    const bytes = packageWith([
      [tc('<w:vMerge w:val="restart"/>', p('a')), plain],
      [tc('<w:vMerge/>', p()), plain],
      [tc('<w:vMerge w:val="continue"/>', p()), plain],
      [tc('', p('d')), plain],
    ]);
    const imported = await importDocx(bytes);
    const [table] = tables(imported.envelope.doc as JsonNode);
    const rows = table!.content!;
    expect(rows.map((r) => r.content!.length)).toEqual([2, 1, 1, 2]);
    expect(rows[0]!.content![0]!.attrs?.['rowspan']).toBe(3);
    expect(rows[3]!.content![0]!.attrs?.['rowspan']).toBeUndefined();
    const out = await exportDocx(imported.envelope, bytes, imported.sourceMap, imported.assets);
    expect(checkR0(bytes, out.bytes).diff.changed).toEqual([]);
  });

  it('a continuation cell with content is not merged', async () => {
    const bytes = packageWith([
      [tc('<w:vMerge w:val="restart"/>', p('a')), plain],
      [tc('<w:vMerge/>', p('kept text')), plain],
    ]);
    const imported = await importDocx(bytes);
    const [table] = tables(imported.envelope.doc as JsonNode);
    expect(table!.content!.map((r) => r.content!.length)).toEqual([2, 2]);
    expect(cellsOf(table!).some((c) => c.attrs?.['rowspan'] !== undefined)).toBe(false);
    const out = await exportDocx(imported.envelope, bytes, imported.sourceMap, imported.assets);
    expect(checkR0(bytes, out.bytes).diff.changed).toEqual([]);
  });

  it('a table where a row would keep no cell of its own is imported without row spans', async () => {
    const wide = (merge: string, body: string): string =>
      `<w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/><w:gridSpan w:val="2"/>${merge}</w:tcPr>${body}</w:tc>`;
    const bytes = packageWith([
      [wide('<w:vMerge w:val="restart"/>', p('w'))],
      [wide('<w:vMerge/>', p())],
      [plain, plain],
    ]);
    const imported = await importDocx(bytes);
    const [table] = tables(imported.envelope.doc as JsonNode);
    expect(table!.content!.map((r) => r.content!.length)).toEqual([1, 1, 2]);
    expect(cellsOf(table!).some((c) => c.attrs?.['rowspan'] !== undefined)).toBe(false);
    expect(table!.content![0]!.content![0]!.attrs?.['colspan']).toBe(2);
  });

  it('the direct writer writes a row span as a restart cell and continuation cells, and reading it back gives the same spans', async () => {
    const bytes = packageWith([
      [tc('<w:vMerge w:val="restart"/>', p('a')), plain],
      [tc('<w:vMerge/>', p()), plain],
      [tc('', p('c')), plain],
    ]);
    const imported = await importDocx(bytes);
    const written = await writeDocx(imported.envelope, new AssetStore());
    const again = await importDocx(written.bytes);
    const [table] = tables(again.envelope.doc as JsonNode);
    expect(table!.content!.map((r) => r.content!.length)).toEqual([2, 1, 2]);
    expect(table!.content![0]!.content![0]!.attrs?.['rowspan']).toBe(2);
  });
});
