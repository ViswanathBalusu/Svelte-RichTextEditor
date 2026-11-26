/**
 * EXP-102, criterion 4 as reworded by owner decision 144 (preserved atoms under A2): hyperlinks
 * and bookmarks arrive as preserved atoms and are written back as they were. A hyperlink whose
 * external address the link allow-list (I9) refuses gets a report line of its own, so that the
 * author knows it is kept but will not become a link in the editor. The fixture is `poi/footnotes.docx`
 * with a body of our own and relationships added.
 */
import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { type JsonNode } from '@docedit/model';
import {
  checkR0,
  exportDocx,
  importDocx,
  readZip,
  writeZip,
  type ZipWriteEntry,
} from '../src/index.ts';
import { REFUSED_LINK_KIND } from '../src/import.ts';
import { corpusFiles, readFile } from './corpus.ts';

const enc = new TextEncoder();
const BASE = corpusFiles().find((f) => f.name === 'poi/footnotes.docx')!;
const REL_HYPERLINK =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';

const link = (id: string, text: string): string =>
  `<w:hyperlink r:id="${id}"><w:r><w:t>${text}</w:t></w:r></w:hyperlink>`;
const rel = (id: string, target: string): string =>
  `<Relationship Id="${id}" Type="${REL_HYPERLINK}" Target="${target}" TargetMode="External"/>`;

/** The fixture with one paragraph of the given content and the given extra relationships. */
function packageWith(content: string, rels: string[]): Uint8Array {
  const zip = readZip(readFile(BASE));
  const parts = unzipSync(readFile(BASE));
  const entries: ZipWriteEntry[] = zip.entries.map((e) => {
    if (e.name === 'word/document.xml') {
      const xml = strFromU8(parts[e.name]!);
      const edited = xml.replace(
        /<w:body>[\s\S]*<\/w:body>/,
        `<w:body><w:p>${content}</w:p></w:body>`,
      );
      expect(edited).not.toBe(xml);
      return { name: e.name, data: enc.encode(edited), like: e };
    }
    if (e.name === 'word/_rels/document.xml.rels') {
      const xml = strFromU8(parts[e.name]!);
      return {
        name: e.name,
        data: enc.encode(xml.replace('</Relationships>', `${rels.join('')}</Relationships>`)),
        like: e,
      };
    }
    return { name: e.name, copyOf: e, from: zip };
  });
  return writeZip(entries);
}

function atoms(doc: JsonNode, label: string): JsonNode[] {
  const out: JsonNode[] = [];
  const stack: JsonNode[] = [doc];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === 'preserved_inline' && n.attrs?.['label'] === label) out.push(n);
    for (const c of n.content ?? []) stack.push(c);
  }
  return out;
}

describe('EXP-102 criterion 4: hyperlinks and bookmarks are kept, and a refused address is reported', () => {
  it('reports a hyperlink with an address outside the allow-list, and not the allowed ones', async () => {
    const bytes = packageWith(
      link('rIdW2a', 'web') +
        link('rIdW2b', 'mail') +
        link('rIdW2c', 'script') +
        link('rIdW2d', 'file'),
      [
        rel('rIdW2a', 'https://example.org/a'),
        rel('rIdW2b', 'mailto:someone@example.org'),
        rel('rIdW2c', 'javascript:alert(1)'),
        rel('rIdW2d', 'file:///C:/secret.txt'),
      ],
    );
    const imported = await importDocx(bytes);
    const refused = imported.report.find((i) => i.kind === REFUSED_LINK_KIND);
    expect(refused?.count).toBe(2);
    expect(refused?.action).toBe('preserved');
    expect(refused?.blocks).toHaveLength(1);
    // All four are kept, as preserved atoms, and the document is written back as it was.
    expect(atoms(imported.envelope.doc as JsonNode, 'hyperlink')).toHaveLength(4);
    const out = await exportDocx(imported.envelope, bytes, imported.sourceMap, imported.assets);
    expect(checkR0(bytes, out.bytes).diff.changed).toEqual([]);
  });

  it('a file with only allowed addresses has no such line', async () => {
    const bytes = packageWith(link('rIdW2a', 'web'), [rel('rIdW2a', 'https://example.org/a')]);
    const imported = await importDocx(bytes);
    expect(imported.report.find((i) => i.kind === REFUSED_LINK_KIND)).toBeUndefined();
  });

  it('a link to a missing relationship, or to a place in the file, is not reported', async () => {
    const bytes = packageWith(
      '<w:hyperlink r:id="rIdNone"><w:r><w:t>none</w:t></w:r></w:hyperlink>' +
        '<w:hyperlink w:anchor="here"><w:r><w:t>here</w:t></w:r></w:hyperlink>',
      [],
    );
    const imported = await importDocx(bytes);
    expect(imported.report.find((i) => i.kind === REFUSED_LINK_KIND)).toBeUndefined();
  });

  it('bookmarks are kept as preserved atoms and written back as they were', async () => {
    const bytes = packageWith(
      '<w:bookmarkStart w:id="7" w:name="target"/><w:r><w:t>text</w:t></w:r><w:bookmarkEnd w:id="7"/>',
      [],
    );
    const imported = await importDocx(bytes);
    expect(atoms(imported.envelope.doc as JsonNode, 'bookmark')).toHaveLength(2);
    const out = await exportDocx(imported.envelope, bytes, imported.sourceMap, imported.assets);
    expect(checkR0(bytes, out.bytes).diff.changed).toEqual([]);
  });
});

describe('EXP-102 criteria 3 and 5: fields, content controls and form fields are kept and reported', () => {
  const FORM_FIELD =
    '<w:r><w:fldChar w:fldCharType="begin"><w:ffData><w:name w:val="Check1"/><w:enabled/>' +
    '<w:checkBox><w:default w:val="0"/></w:checkBox></w:ffData></w:fldChar></w:r>' +
    '<w:r><w:instrText xml:space="preserve"> FORMCHECKBOX </w:instrText></w:r>' +
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
  const SDT =
    '<w:sdt><w:sdtPr><w:alias w:val="A"/><w:tag w:val="t"/><w:text/></w:sdtPr>' +
    '<w:sdtContent><w:r><w:t>control text</w:t></w:r></w:sdtContent></w:sdt>';
  const FIELDS =
    '<w:r><w:t xml:space="preserve">Page </w:t></w:r>' +
    '<w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple>' +
    '<w:fldSimple w:instr=" NUMPAGES "><w:r><w:t>9</w:t></w:r></w:fldSimple>' +
    '<w:fldSimple w:instr=" SEQ Figure \* ARABIC "><w:r><w:t>3</w:t></w:r></w:fldSimple>' +
    '<w:fldSimple w:instr=" XYZZY unknown "><w:r><w:t>cached</w:t></w:r></w:fldSimple>';

  it('fields are reported with a count, and the file is written back as it was', async () => {
    const bytes = packageWith(FIELDS, []);
    const imported = await importDocx(bytes);
    const line = imported.report.find((i) => i.kind === 'field');
    expect(line?.count).toBe(4);
    expect(line?.action).toBe('preserved');
    const out = await exportDocx(imported.envelope, bytes, imported.sourceMap, imported.assets);
    expect(checkR0(bytes, out.bytes).diff.changed).toEqual([]);
  });

  it('a content control and a form field are kept as preserved and reported', async () => {
    const bytes = packageWith(SDT + FORM_FIELD, []);
    const imported = await importDocx(bytes);
    const kinds = imported.report.map((i) => `${i.kind}:${i.action}`);
    expect(kinds).toContain('content control:preserved');
    expect(imported.report.some((i) => /field/.test(i.kind))).toBe(true);
    const out = await exportDocx(imported.envelope, bytes, imported.sourceMap, imported.assets);
    expect(checkR0(bytes, out.bytes).diff.changed).toEqual([]);
  });
});
