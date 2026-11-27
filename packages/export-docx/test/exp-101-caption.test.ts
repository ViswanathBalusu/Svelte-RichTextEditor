/**
 * EXP-101, criterion 5 as reworded under owner decision 144 (A2, ADR 0017): a caption arrives as a
 * paragraph of the built-in `Caption` style, its `SEQ` field is kept as preserved field content (the
 * same reading as EXP-102 criterion 3, which names sequences), the import report names the field, and
 * an unedited file is written back as it was. The fixture is `poi/footnotes.docx` with a body of our
 * own and a `Caption` style added to its styles.
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
import { corpusFiles, readFile } from './corpus.ts';

const enc = new TextEncoder();
const BASE = corpusFiles().find((f) => f.name === 'poi/footnotes.docx')!;

const CAPTION_STYLE =
  '<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/>' +
  '<w:basedOn w:val="Normal"/><w:qFormat/><w:rPr><w:i/></w:rPr></w:style>';

const COMPLEX =
  '<w:r><w:t xml:space="preserve">Figure </w:t></w:r>' +
  '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
  '<w:r><w:instrText xml:space="preserve"> SEQ Figure \\* ARABIC </w:instrText></w:r>' +
  '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
  '<w:r><w:t>1</w:t></w:r>' +
  '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
  '<w:r><w:t xml:space="preserve">. A picture</w:t></w:r>';
const SIMPLE =
  '<w:r><w:t xml:space="preserve">Table </w:t></w:r>' +
  '<w:fldSimple w:instr=" SEQ Table \\* ARABIC "><w:r><w:t>2</w:t></w:r></w:fldSimple>' +
  '<w:r><w:t xml:space="preserve">. Results</w:t></w:r>';

/** The fixture with a `Caption` style and a body of the given captions, one paragraph each. */
function packageWith(captions: string[]): Uint8Array {
  const zip = readZip(readFile(BASE));
  const parts = unzipSync(readFile(BASE));
  const entries: ZipWriteEntry[] = zip.entries.map((e) => {
    if (e.name === 'word/document.xml') {
      const xml = strFromU8(parts[e.name]!);
      const body = captions
        .map((c) => `<w:p><w:pPr><w:pStyle w:val="Caption"/></w:pPr>${c}</w:p>`)
        .join('');
      const edited = xml.replace(/<w:body>[\s\S]*<\/w:body>/, `<w:body>${body}</w:body>`);
      expect(edited).not.toBe(xml);
      return { name: e.name, data: enc.encode(edited), like: e };
    }
    if (e.name === 'word/styles.xml') {
      const xml = strFromU8(parts[e.name]!);
      const edited = xml.replace('</w:styles>', `${CAPTION_STYLE}</w:styles>`);
      expect(edited).not.toBe(xml);
      return { name: e.name, data: enc.encode(edited), like: e };
    }
    return { name: e.name, copyOf: e, from: zip };
  });
  return writeZip(entries);
}

function paragraphs(doc: JsonNode): JsonNode[] {
  const out: JsonNode[] = [];
  const walk = (n: JsonNode): void => {
    if (n.type === 'paragraph') out.push(n);
    for (const c of n.content ?? []) walk(c);
  };
  walk((doc.content ?? []).find((n) => n.type === 'body')!);
  return out;
}

const textOf = (n: JsonNode): string =>
  (n.content ?? []).map((c) => (c.type === 'text' ? String(c.text ?? '') : textOf(c))).join('');

describe('EXP-101 criterion 5: a caption is a Caption paragraph and its SEQ field is kept', () => {
  it('imports a caption with a complex SEQ field as a Caption paragraph with the field preserved, and writes the file back as it was', async () => {
    const bytes = packageWith([COMPLEX]);
    const imported = await importDocx(bytes);
    const [p] = paragraphs(imported.envelope.doc as JsonNode);
    expect(p!.attrs?.['style']).toBe('Caption');
    expect(textOf(p!)).toContain('Figure ');
    expect(textOf(p!)).toContain('. A picture');
    const line = imported.report.find((i) => i.kind === 'field');
    // The report counts the elements of a field: begin, separate and end of a complex one.
    expect(line?.count).toBe(3);
    expect(line?.action).toBe('preserved');
    expect(validate(imported.envelope, { attachedAssets: imported.assets.ids() }).valid).toBe(true);
    const out = await exportDocx(imported.envelope, bytes, imported.sourceMap, imported.assets);
    expect(checkR0(bytes, out.bytes).diff.changed).toEqual([]);
  });

  it('does the same for a simple field, and reports both kinds in one file', async () => {
    const bytes = packageWith([COMPLEX, SIMPLE]);
    const imported = await importDocx(bytes);
    const paras = paragraphs(imported.envelope.doc as JsonNode);
    expect(paras.map((p) => p.attrs?.['style'])).toEqual(['Caption', 'Caption']);
    expect(imported.report.find((i) => i.kind === 'field')?.count).toBe(4);
    const out = await exportDocx(imported.envelope, bytes, imported.sourceMap, imported.assets);
    expect(checkR0(bytes, out.bytes).diff.changed).toEqual([]);
  });
});
