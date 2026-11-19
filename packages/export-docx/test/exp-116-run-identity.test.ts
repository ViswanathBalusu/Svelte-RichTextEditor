/**
 * EXP-116, third criterion, for runs: identity-bound values (rsid attributes) inside the residue of
 * a run's properties are recorded only in the source map, never in the `preserved` mark of the
 * document, and a regenerated paragraph writes them back. The synthetic package holds one run whose
 * `w:rPr` has a property the model does not represent, carrying an rsid value, and one whose
 * residue has none. Pure Node.js; no container.
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

const RUN_VALUE = '00A7B8C9';
const OTHER_VALUE = '00D7E8F9';

const BODY =
  '<w:p><w:r><w:rPr><w:b/>' +
  `<w:eastAsianLayout w:id="7" w:vert="1" w:rsidR="${RUN_VALUE}"/></w:rPr><w:t>first run</w:t></w:r>` +
  `<w:r w:rsidR="${OTHER_VALUE}"><w:rPr><w:eastAsianLayout w:id="8" w:combine="1"/></w:rPr><w:t> second run</w:t></w:r></w:p>`;

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
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

function firstParagraph(envelope: unknown): Node {
  const doc = (envelope as { doc: Node }).doc;
  const body = doc.content!.find((n) => n.type === 'body')!;
  return body.content!.find((n) => n.type === 'paragraph')!;
}

describe('EXP-116: identity-bound values of run properties stay out of the document', () => {
  it('keeps the rsid value of the run residue out of the document and the mark', async () => {
    const { envelope } = await importDocx(documentPackage(BODY));
    const json = JSON.stringify(envelope);
    expect(json).not.toContain(RUN_VALUE);
    expect(json).not.toContain(OTHER_VALUE);
    const marks = (firstParagraph(envelope).content ?? []).flatMap((n) => n.marks ?? []);
    expect(
      marks.some((m) => m.type === 'preserved'),
      'the run keeps its residue as a mark',
    ).toBe(true);
  });

  it('records the rsid value of the run residue in the source map', async () => {
    const imported = await importDocx(documentPackage(BODY));
    expect(JSON.stringify(imported.sourceMap.runIdentity)).toContain(RUN_VALUE);
  });

  it('writes the rsid value back on a regenerated paragraph', async () => {
    const bytes = documentPackage(BODY);
    const imported = await importDocx(bytes);
    const id = String(firstParagraph(imported.envelope).attrs!['id']);
    const out = await exportDocx(imported.envelope, bytes, imported.sourceMap, imported.assets, {
      regenerate: new Set([id]),
    });
    const zip = readZip(out.bytes);
    const xml = new TextDecoder().decode(entryData(zip, zip.byName.get('word/document.xml')!));
    expect(xml).toContain(`w:rsidR="${RUN_VALUE}"`);
  });
});
