/**
 * EXP-097: writes the hostile files the candidates are run on, one package per file, into the
 * directory given as the first argument. The first seven are the cases of
 * `packages/export-docx/test/hostile-corpus.test.ts` (EXP-110, criterion 2). The eighth is a
 * picture linked to a local file: the shape of the directory traversal advisory of mammoth
 * (CVE-2025-11849). It links the file given as the second argument, which holds a marker text; a
 * candidate that puts the marker in its output has read a file outside the package.
 *
 * Run: node docs/spikes/exp-097/make-hostile.mts <out dir> <marker file>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  entryData,
  readZip,
  writeZip,
  type ZipWriteEntry,
} from '../../../packages/export-docx/src/index.ts';
import { readFileSync } from 'node:fs';

const [outArg, markerArg] = process.argv.slice(2);
if (!outArg || !markerArg) throw new Error('usage: make-hostile.mts <out dir> <marker file>');
const outDir = resolve(outArg);
mkdirSync(outDir, { recursive: true });

const SAMPLE = new URL(
  '../../../packages/export-docx/corpus/docx4j/sample-docx.docx',
  import.meta.url,
);
const sampleBytes = new Uint8Array(readFileSync(SAMPLE));
const enc = new TextEncoder();

function withParts(changes: Record<string, Uint8Array | string>): Uint8Array {
  const zip = readZip(sampleBytes);
  const entries: ZipWriteEntry[] = [];
  for (const e of zip.entries) {
    const change = changes[e.name];
    if (change === undefined) entries.push({ name: e.name, copyOf: e, from: zip });
    else
      entries.push({
        name: e.name,
        data: typeof change === 'string' ? enc.encode(change) : change,
        like: e,
      });
  }
  for (const [name, data] of Object.entries(changes)) {
    if (zip.byName.has(name)) continue;
    entries.push({ name, data: typeof data === 'string' ? enc.encode(data) : data });
  }
  return writeZip(entries);
}

function part(name: string): string {
  const zip = readZip(sampleBytes);
  return new TextDecoder().decode(entryData(zip, zip.byName.get(name)!));
}

const documentXml = part('word/document.xml');
const relsXml = part('word/_rels/document.xml.rels');
const files: Record<string, Uint8Array> = {};

files['h1-zip-bomb'] = withParts({ 'customXml/bomb.xml': new Uint8Array(40 * 1024 * 1024) });

const dtd =
  '<!DOCTYPE w:document [' +
  '<!ENTITY a "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">' +
  '<!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">' +
  '<!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">' +
  ']>';
files['h2-dtd-entities'] = withParts({
  'word/document.xml': documentXml.replace(/^(<\?xml[^>]*\?>)?/, (m) => `${m}${dtd}`),
});

files['h3-macro'] = withParts({ 'word/vbaProject.bin': new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]) });

files['h4-external-link'] = withParts({
  'word/_rels/document.xml.rels': relsXml.replace(
    '</Relationships>',
    '<Relationship Id="rIdHostile1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="http://example.invalid/steal" TargetMode="External"/></Relationships>',
  ),
});

files['h5-embedded-object'] = withParts({
  'word/embeddings/Microsoft_Word_Document1.docx': writeZip([
    { name: 'word/document.xml', data: enc.encode('<x') },
  ]),
});

const depth = 20_000;
files['h6-deep-nesting'] = withParts({
  'word/document.xml': documentXml.replace(
    '<w:body>',
    `<w:body><w:p>${'<w:ins w:id="1" w:author="a">'.repeat(depth)}${'</w:ins>'.repeat(depth)}</w:p>`,
  ),
});

const cell = '<w:tc><w:p><w:r><w:t>c</w:t></w:r></w:p></w:tc>';
const row = `<w:tr>${cell.repeat(50)}</w:tr>`;
files['h7-large-table'] = withParts({
  'word/document.xml': documentXml.replace('<w:body>', `<w:body><w:tbl>${row.repeat(200)}</w:tbl>`),
});

const picture =
  '<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">' +
  '<wp:extent cx="100" cy="100"/><wp:docPr id="1" name="linked"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
  '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
  '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill>' +
  '<a:blip r:link="rIdHostileImg"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline>' +
  '</w:drawing></w:r></w:p>';
const target = pathToFileURL(resolve(markerArg)).href;
files['h8-linked-local-file'] = withParts({
  'word/document.xml': documentXml.replace('<w:body>', `<w:body>${picture}`),
  'word/_rels/document.xml.rels': relsXml.replace(
    '</Relationships>',
    `<Relationship Id="rIdHostileImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${target}" TargetMode="External"/></Relationships>`,
  ),
});

for (const [name, bytes] of Object.entries(files)) {
  writeFileSync(join(outDir, `${name}.docx`), bytes);
  console.log(name, bytes.length);
}
