/**
 * EXP-110, criterion 2 (memory half): the hostile packages built for the memory measurement. The
 * same shapes as `hostile-corpus.test.ts`, written to disk so that a child process can import each
 * one in a fresh Node.js process and report its peak resident set size.
 */
import { readFileSync } from 'node:fs';
import { entryData, readZip, writeZip, type ZipWriteEntry } from '../src/index.ts';
import { corpusFiles, readFile } from './corpus.ts';

const SAMPLE = corpusFiles().find((f) => f.name === 'docx4j/sample-docx.docx')!;

export const CASES = [
  'zip-bomb',
  'dtd-entities',
  'macro-enabled',
  'external-relationship',
  'embedded-object',
  'deep-nesting',
  'large-table',
] as const;
export type CaseName = (typeof CASES)[number];

function withParts(changes: Record<string, Uint8Array | string>): Uint8Array {
  const zip = readZip(readFile(SAMPLE));
  const enc = new TextEncoder();
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

function documentXml(): string {
  const zip = readZip(readFile(SAMPLE));
  return new TextDecoder().decode(entryData(zip, zip.byName.get('word/document.xml')!));
}

/** The package of one case. */
export function buildCase(name: CaseName): Uint8Array {
  if (name === 'zip-bomb')
    return withParts({ 'customXml/bomb.xml': new Uint8Array(40 * 1024 * 1024) });
  if (name === 'dtd-entities') {
    const dtd =
      '<!DOCTYPE w:document [' +
      '<!ENTITY a "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">' +
      '<!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">' +
      '<!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">' +
      ']>';
    return withParts({
      'word/document.xml': documentXml().replace(/^(<?xml[^>]*?>)?/, (m) => `${m}${dtd}`),
    });
  }
  if (name === 'macro-enabled')
    return withParts({ 'word/vbaProject.bin': new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]) });
  if (name === 'external-relationship') {
    const zip = readZip(readFile(SAMPLE));
    const rels = new TextDecoder().decode(
      entryData(zip, zip.byName.get('word/_rels/document.xml.rels')!),
    );
    const extra =
      '<Relationship Id="rIdHostile1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="http://example.invalid/steal" TargetMode="External"/>';
    return withParts({
      'word/_rels/document.xml.rels': rels.replace('</Relationships>', `${extra}</Relationships>`),
    });
  }
  if (name === 'embedded-object') {
    const inner = writeZip([{ name: 'word/document.xml', data: new TextEncoder().encode('<x') }]);
    return withParts({ 'word/embeddings/Microsoft_Word_Document1.docx': inner });
  }
  if (name === 'deep-nesting') {
    const depth = 20_000;
    const open = '<w:ins w:id="1" w:author="a">'.repeat(depth);
    const close = '</w:ins>'.repeat(depth);
    return withParts({
      'word/document.xml': documentXml().replace('<w:body>', `<w:body><w:p>${open}${close}</w:p>`),
    });
  }
  const cell = '<w:tc><w:p><w:r><w:t>c</w:t></w:r></w:p></w:tc>';
  const table = `<w:tbl>${`<w:tr>${cell.repeat(50)}</w:tr>`.repeat(200)}</w:tbl>`;
  return withParts({ 'word/document.xml': documentXml().replace('<w:body>', `<w:body>${table}`) });
}

/** Reads a case file written by the test, for the child process. */
export const readCase = (path: string): Uint8Array => new Uint8Array(readFileSync(path));
