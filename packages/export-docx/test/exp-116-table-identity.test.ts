/**
 * EXP-116, third criterion, for tables: identity-bound values (rsid attributes) of a table, its row,
 * its cell and the property residue inside them are recorded only in the source map, never in the
 * document, and a regenerated table writes them back. The synthetic package holds one table with
 * rsid values on each element and on a property child of the cell. Pure Node.js; no container.
 */
import { describe, expect, it } from 'vitest';
import {
  entryData,
  exportDocx,
  importDocx,
  readZip,
  writeZip,
  type ZipWriteEntry,
} from '../src/index.ts';
import { corpusFiles, readFile } from './corpus.ts';

const SAMPLE = corpusFiles().find((f) => f.name === 'docx4j/sample-docx.docx')!;

const NS = [
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
].join(' ');

const TBL = '00A1B2C3';
const TR = '00B1B2C3';
const TR_SESSION = '00C1C2C3';
const TC = '00D1D2D3';
const P = '00E1E2E3';
const CNF = '00F1F2F3';
const VALUES = [TBL, TR, TR_SESSION, TC, P, CNF];

const BODY =
  `<w:tbl w:rsidR="${TBL}"><w:tblPr><w:tblW w:w="5000" w:type="dxa"/></w:tblPr>` +
  '<w:tblGrid><w:gridCol w:w="5000"/></w:tblGrid>' +
  `<w:tr w:rsidR="${TR}" w:rsidTr="${TR_SESSION}"><w:tc w:rsidR="${TC}">` +
  `<w:tcPr><w:tcW w:w="5000" w:type="dxa"/><w:cnfStyle w:val="000000100000" w:rsidR="${CNF}"/></w:tcPr>` +
  `<w:p w:rsidR="${P}"><w:r><w:t>cell text</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`;

function documentPackage(body: string): Uint8Array {
  const zip = readZip(readFile(SAMPLE));
  const xml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${NS}><w:body>` +
    `${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`;
  const enc = new TextEncoder();
  const entries: ZipWriteEntry[] = zip.entries.map((e) =>
    e.name === 'word/document.xml'
      ? { name: e.name, data: enc.encode(xml), like: e }
      : { name: e.name, copyOf: e, from: zip },
  );
  return writeZip(entries);
}

interface Node {
  type: string;
  attrs?: Record<string, unknown>;
  content?: Node[];
}

describe('EXP-116: identity-bound values of tables, rows and cells stay out of the document', () => {
  it('keeps every rsid value of the table, its row, its cell and the cell residue out of the document', async () => {
    const { envelope } = await importDocx(documentPackage(BODY));
    const json = JSON.stringify(envelope);
    for (const value of VALUES) expect(json).not.toContain(value);
  });

  it('records the rsid values of the table, its row and its cell in the source map', async () => {
    const imported = await importDocx(documentPackage(BODY));
    const [table, row, cell] = tableChain(imported.envelope);
    const nodes = imported.sourceMap.nodes;
    expect(JSON.stringify(nodes[String(table!.attrs!['id'])])).toContain(TBL);
    expect(JSON.stringify(nodes[String(row!.attrs!['id'])])).toContain(TR_SESSION);
    expect(JSON.stringify(nodes[String(cell!.attrs!['id'])])).toContain(TC);
    // The rsid of the cell's property residue is kept in the cell's identity tree.
    expect(JSON.stringify(nodes[String(cell!.attrs!['id'])])).toContain(CNF);
  });

  it('writes the rsid values back on a regenerated table, row and cell', async () => {
    const bytes = documentPackage(BODY);
    const imported = await importDocx(bytes);
    const ids = tableChain(imported.envelope).map((n) => String(n!.attrs!['id']));
    const out = await exportDocx(imported.envelope, bytes, imported.sourceMap, imported.assets, {
      regenerate: new Set(ids),
    });
    const zip = readZip(out.bytes);
    const xml = new TextDecoder().decode(entryData(zip, zip.byName.get('word/document.xml')!));
    expect(xml).toContain(`<w:tbl w:rsidR="${TBL}"`);
    expect(xml).toContain(`w:rsidTr="${TR_SESSION}"`);
    expect(xml).toContain(`w:rsidR="${TC}"`);
    expect(xml).toContain(`w:rsidR="${CNF}"`);
  });
});

/** The table, its first row and the first cell of that row, in document order. */
function tableChain(envelope: unknown): Array<Node | undefined> {
  const doc = (envelope as { doc: Node }).doc;
  const body = doc.content!.find((n) => n.type === 'body')!;
  const table = body.content!.find((n) => n.type === 'table');
  const row = table?.content?.[0];
  const cell = row?.content?.[0];
  return [table, row, cell];
}
