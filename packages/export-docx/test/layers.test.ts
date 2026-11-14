/**
 * The building blocks of the S11 prototype: the ZIP container (raw copies), the XML parser (byte
 * offsets, namespaces, refusals), canonical XML, element trees and the linear node hasher.
 */
import { describe, expect, it } from 'vitest';
import { canonicalNodeText, utf8, type JsonNode } from '@docedit/model';
import {
  NodeHasher,
  ZipError,
  XmlError,
  canonical,
  checkPreserved,
  crc32,
  entryData,
  exportDocx,
  importDocx,
  parseXml,
  pname,
  rawData,
  splitPname,
  readZip,
  writeZip,
} from '../src/index.ts';
import { ImportError } from '../src/import.ts';
import { NS } from '../src/ooxml.ts';
import { corpusFiles, readFile } from './corpus.ts';

const text = (s: string): Uint8Array => utf8(s);

describe('ZIP', () => {
  it('computes CRC-32 as ZIP does', () => {
    expect(crc32(text('123456789'))).toBe(0xcbf43926);
  });

  it('copies entries raw: same compressed bytes, CRC and sizes', () => {
    const zip = writeZip([
      { name: 'a.xml', data: text('<a>' + 'x'.repeat(5000) + '</a>') },
      { name: 'b.bin', data: text('stored'), store: true },
    ]);
    const a = readZip(zip);
    const copy = readZip(writeZip(a.entries.map((e) => ({ name: e.name, copyOf: e, from: a }))));
    for (const e of a.entries) {
      const c = copy.byName.get(e.name)!;
      expect([c.crc32, c.compressedSize, c.size, c.method]).toEqual([
        e.crc32,
        e.compressedSize,
        e.size,
        e.method,
      ]);
      expect(rawData(copy, c)).toEqual(rawData(a, e));
      expect(entryData(copy, c)).toEqual(entryData(a, e));
    }
  });

  it('reads entries written with data descriptors (LibreOffice)', () => {
    const f = corpusFiles().find((x) => x.name === 'poi/comment.docx')!;
    const zip = readZip(readFile(f));
    expect(zip.entries.some((e) => e.flags & 8)).toBe(true);
    for (const e of zip.entries) expect(entryData(zip, e).length).toBe(e.size);
  });

  it('refuses a damaged archive and enforces its limits before expanding anything', () => {
    expect(() => readZip(text('not a zip'))).toThrow(ZipError);
    const zip = writeZip([{ name: 'a', data: new Uint8Array(1_000_000) }]);
    expect(() => readZip(zip, { maxEntries: 10, maxTotalSize: 1000, maxRatio: 1000 })).toThrow(
      /uncompressed size/,
    );
    expect(() => readZip(zip, { maxEntries: 10, maxTotalSize: 1e9, maxRatio: 10 })).toThrow(
      /compression ratio/,
    );
  });
});

describe('XML', () => {
  it('records byte offsets of start tags, content and end tags', () => {
    const src = '<?xml version="1.0"?><r xmlns:w="urn:w"><w:p a="1">é<w:x/></w:p></r>';
    const bytes = text(src);
    const doc = parseXml(bytes);
    const p = doc.root.children[0]!;
    if (p.kind !== 'element') throw new Error('no element');
    const slice = (s: number, e: number): string => new TextDecoder().decode(bytes.subarray(s, e));
    expect(slice(p.start, p.end)).toBe('<w:p a="1">é<w:x/></w:p>');
    expect(slice(p.start, p.startTagEnd)).toBe('<w:p a="1">');
    expect(slice(p.endTagStart, p.end)).toBe('</w:p>');
    expect(p.ns).toBe('urn:w');
  });

  it('refuses document type declarations, undeclared entities, unbound prefixes and UTF-16', () => {
    expect(() => parseXml(text('<!DOCTYPE r [<!ENTITY x "y">]><r>&x;</r>'))).toThrow(
      /document type/,
    );
    expect(() => parseXml(text('<r>&x;</r>'))).toThrow(/undeclared entity/);
    expect(() => parseXml(text('<a:r/>'))).toThrow(/unbound prefix/);
    expect(() => parseXml(new Uint8Array([0xff, 0xfe, 0x3c, 0]))).toThrow(/UTF-16/);
    expect(() => parseXml(text('<r><a></r>'))).toThrow(XmlError);
  });

  it('compares canonically: prefixes, attribute order, empty elements and references do not matter', () => {
    const a = parseXml(text('<x:r xmlns:x="urn:n" b="2" a="1"><x:e/>&#65;</x:r>')).root;
    const b = parseXml(text('<y:r xmlns:y="urn:n" a="1" b="2"><y:e></y:e>A</y:r>')).root;
    expect(canonical(a)).toBe(canonical(b));
  });
});

describe('element trees', () => {
  it('accept registered prefixes, Clark names of other namespaces and string values within the grammar, and nothing else', () => {
    expect(checkPreserved({ children: [{ name: 'w:b', attrs: { 'w:val': '1' } }] })).toEqual([]);
    expect(
      checkPreserved({ children: [{ name: '{urn:other}b', attrs: { '{urn:other}val': '1' } }] }),
    ).toEqual([]);
    // A Clark name of a registered namespace has another spelling, so it is refused (I11).
    expect(checkPreserved({ children: [{ name: `{${NS.w}}b` }] }).length).toBeGreaterThan(0);
    expect(checkPreserved({ children: [{ name: '<script>' }] }).length).toBeGreaterThan(0);
    const deep = { name: 'w:a', children: [] as unknown[] };
    let cur = deep;
    for (let i = 0; i < 12; i++) {
      const next = { name: 'w:a', children: [] as unknown[] };
      cur.children.push(next);
      cur = next;
    }
    expect(checkPreserved({ children: [deep as never] }).join(' ')).toMatch(/deeper than 12/);
  });

  it("spell every name from its namespace URI, never from the part's prefix", () => {
    expect(pname(NS.w, 'p')).toBe('w:p');
    expect(pname('urn:other', 'p')).toBe('{urn:other}p');
    expect(pname('', 'id')).toBe('id');
    expect(splitPname('w14:paraId')).toEqual([NS.w14, 'paraId']);
    const a = parseXml(text(`<x:p xmlns:x="${NS.w}" x:val="1"/>`)).root;
    expect(canonical(a)).toBe('<w:p w:val="1"></w:p>');
  });
});

describe('the linear node hasher', () => {
  it('gives every node of every corpus document the text of canonicalNodeText', async () => {
    for (const f of corpusFiles().filter((x) => !x.name.includes('deep-table-cell'))) {
      const { envelope } = await importDocx(readFile(f));
      const hasher = new NodeHasher();
      const walk = (n: JsonNode): void => {
        if (['table', 'table_row', 'table_cell', 'story', 'body', 'paragraph'].includes(n.type))
          expect(hasher.text(n), `${f.name} ${n.type}`).toBe(canonicalNodeText(n));
        for (const c of n.content ?? []) walk(c);
      };
      walk(envelope.doc);
    }
  });
});

describe('hostile and unsupported input', () => {
  const base = (): Uint8Array =>
    readFile(corpusFiles().find((x) => x.name === 'python-docx/tab-stops.docx')!);
  const withPart = (
    name: string,
    data: Uint8Array,
    contentTypeOverride?: [string, string],
  ): Uint8Array => {
    const zip = readZip(base());
    const entries = zip.entries.map((e) => {
      if (e.name === name) return { name, data, like: e };
      if (contentTypeOverride && e.name === '[Content_Types].xml') {
        const ct = new TextDecoder()
          .decode(entryData(zip, e))
          .replace(contentTypeOverride[0], contentTypeOverride[1]);
        return { name: e.name, data: text(ct), like: e };
      }
      return { name: e.name, copyOf: e, from: zip };
    });
    return writeZip(entries);
  };

  it('refuses a part with a document type declaration', async () => {
    const bad = withPart(
      'word/document.xml',
      text('<?xml version="1.0"?><!DOCTYPE w:document [<!ENTITY a "b">]><w:document/>'),
    );
    await expect(importDocx(bad)).rejects.toThrow(ImportError);
  });

  it('refuses a macro-enabled file', async () => {
    const zip = readZip(base());
    const ct = entryData(zip, zip.byName.get('[Content_Types].xml')!);
    const macro = new TextDecoder()
      .decode(ct)
      .replace(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
        'application/vnd.ms-word.document.macroEnabled.main+xml',
      );
    const bad = withPart('[Content_Types].xml', text(macro));
    await expect(importDocx(bad)).rejects.toThrow(/macro-enabled/);
  });

  it('survives 5,000 nested tables (poi/deep-table-cell.docx) and still passes R0', async () => {
    const bytes = readFile(corpusFiles().find((x) => x.name === 'poi/deep-table-cell.docx')!);
    const imported = await importDocx(bytes);
    const out = await exportDocx(imported.envelope, bytes, imported.sourceMap, imported.assets);
    expect(out.regenerated).toEqual([]);
  });
});
