/**
 * EXP-117, criterion 3, the rendering half: when the file holds a picture of preserved content
 * (the fallback of alternate content, the image of an embedded object, a picture), the atom's
 * `fallbackAsset` names that picture, an asset the import made; when it holds none, `fallbackText`
 * names the kind (`exp-117-fallback.test.ts`).
 *
 * A synthetic package holds one block of each shape, with the picture `word/media/image3.png` of
 * the base file (relationship `rId11`) or none. The corpus is checked too: every preserved atom
 * whose original XML refers to an image relationship has a fallback asset, and no atom has one
 * without such a reference.
 */
import { describe, expect, it } from 'vitest';
import type { JsonNode } from '@docedit/model';
import { importDocx, readZip, writeZip, type ZipWriteEntry } from '../src/index.ts';
import { corpusFiles, readFile } from './corpus.ts';

const SAMPLE = corpusFiles().find((f) => f.name === 'docx4j/sample-docx.docx')!;

const NAMESPACES = [
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"',
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"',
  'xmlns:v="urn:schemas-microsoft-com:vml"',
  'xmlns:o="urn:schemas-microsoft-com:office:office"',
].join(' ');

const para = (inner: string): string => `<w:p><w:r>${inner}</w:r></w:p>`;

/** An embedded object whose image is the PNG of the base file. */
const OBJECT_WITH_PICTURE = para(
  '<w:object><v:shape id="_x0000_i1025" type="#_x0000_t75" style="width:96pt;height:48pt">' +
    '<v:imagedata r:id="rId11"/></v:shape>' +
    '<o:OLEObject Type="Embed" ProgID="Excel.Sheet.12" ShapeID="_x0000_i1025"/></w:object>',
);
/** Alternate content whose choice Word 2010 reads and whose fallback is the PNG. */
const ALTERNATE_WITH_FALLBACK = para(
  '<mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:inline>' +
    '<wp:extent cx="1270000" cy="635000"/><wp:docPr id="2" name="Box"/><a:graphic>' +
    '<a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
    '<wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr/><wps:txbx><w:txbxContent>' +
    '<w:p><w:r><w:t>Boxed</w:t></w:r></w:p></w:txbxContent></wps:txbx></wps:wsp>' +
    '</a:graphicData></a:graphic></wp:inline></w:drawing></mc:Choice>' +
    '<mc:Fallback><w:pict><v:shape id="Box" style="width:100pt;height:50pt">' +
    '<v:imagedata r:id="rId11"/></v:shape></w:pict></mc:Fallback></mc:AlternateContent>',
);
/** A text box with no picture anywhere: the kind is its fallback text. */
const TEXT_BOX_WITHOUT_PICTURE = para(
  '<w:drawing><wp:inline><wp:extent cx="1270000" cy="635000"/><wp:docPr id="3" name="Plain"/>' +
    '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
    '<wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr/><wps:txbx><w:txbxContent>' +
    '<w:p><w:r><w:t>Plain</w:t></w:r></w:p></w:txbxContent></wps:txbx></wps:wsp>' +
    '</a:graphicData></a:graphic></wp:inline></w:drawing>',
);

function documentPackage(body: string): Uint8Array {
  const zip = readZip(readFile(SAMPLE));
  const xml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${NAMESPACES}><w:body>` +
    `${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`;
  const enc = new TextEncoder();
  const entries: ZipWriteEntry[] = zip.entries.map((e) =>
    e.name === 'word/document.xml'
      ? { name: e.name, data: enc.encode(xml), like: e }
      : { name: e.name, copyOf: e, from: zip },
  );
  return writeZip(entries);
}

function atomsOf(doc: JsonNode): JsonNode[] {
  const out: JsonNode[] = [];
  const stack: JsonNode[] = [doc];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === 'preserved_inline' || n.type === 'preserved_block') out.push(n);
    for (const c of n.content ?? []) stack.push(c);
  }
  return out.reverse();
}

describe('EXP-117 criterion 3: a rendering in the file becomes the fallback asset', () => {
  it('an embedded object with an image keeps the image as its fallback asset', async () => {
    const imported = await importDocx(documentPackage(OBJECT_WITH_PICTURE));
    const [atom] = atomsOf(imported.envelope.doc as JsonNode);
    expect(atom?.attrs?.['label']).toBe('embedded object');
    const asset = atom?.attrs?.['fallbackAsset'];
    expect(typeof asset).toBe('string');
    expect(imported.assets.get(String(asset)), 'the asset is one the import made').toBeDefined();
  });

  it('alternate content whose fallback is a picture keeps that picture as the fallback asset', async () => {
    const imported = await importDocx(documentPackage(ALTERNATE_WITH_FALLBACK));
    const atoms = atomsOf(imported.envelope.doc as JsonNode);
    expect(atoms.length).toBeGreaterThan(0);
    const asset = atoms[0]?.attrs?.['fallbackAsset'];
    expect(typeof asset, JSON.stringify(atoms[0]?.attrs)).toBe('string');
    expect(imported.assets.get(String(asset))).toBeDefined();
  });

  it('a text box with no picture has no fallback asset and names its kind', async () => {
    const imported = await importDocx(documentPackage(TEXT_BOX_WITHOUT_PICTURE));
    const [atom] = atomsOf(imported.envelope.doc as JsonNode);
    expect(atom?.attrs?.['fallbackAsset']).toBeUndefined();
    expect(atom?.attrs?.['fallbackText']).toBe('text box');
  });

  it('the corpus: embedded objects, charts and pictures that refer to an image have a fallback asset', async () => {
    let withAsset = 0;
    for (const file of corpusFiles()) {
      const imported = await importDocx(readFile(file));
      for (const atom of atomsOf(imported.envelope.doc as JsonNode)) {
        const asset = atom.attrs?.['fallbackAsset'];
        if (asset === undefined) continue;
        withAsset++;
        expect(
          imported.assets.get(String(asset)),
          `${file.name} ${atom.attrs?.['label']}`,
        ).toBeDefined();
      }
    }
    expect(withAsset).toBeGreaterThan(10);
  });
});
