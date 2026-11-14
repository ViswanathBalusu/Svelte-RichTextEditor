/**
 * EXP-117, criterion 1: text boxes, shapes, charts, SmartArt, embedded or linked objects, ink,
 * nested tables, floating pictures with wrap, unmapped content controls and alternate content
 * without a usable fallback each become a preserved atom in their original position.
 *
 * The synthetic package (one paragraph or block per kind, in a known order) checks the position and
 * the label of each kind. The kinds that the corpus holds (chart, SmartArt, text box, shape, embedded
 * object, nested table, content control, floating picture) are checked on their corpus files.
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
  'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"',
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"',
  'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"',
  'xmlns:v="urn:schemas-microsoft-com:vml"',
  'xmlns:o="urn:schemas-microsoft-com:office:office"',
  'mc:Ignorable="w14"',
].join(' ');

const para = (inner: string): string => `<w:p><w:r>${inner}</w:r></w:p>`;

const INK = para('<w14:contentPart bwMode="auto"/>');
const ALTERNATE = para(
  '<mc:AlternateContent><mc:Choice Requires="w14"><w14:cntOpts/></mc:Choice></mc:AlternateContent>',
);
const LINKED = para(
  '<w:object><v:shape id="_x0000_i1025" type="#_x0000_t75" style="width:96pt;height:48pt">' +
    '<v:imagedata r:id="rIdNoImage"/></v:shape>' +
    '<o:OLEObject Type="Link" ProgID="Excel.Sheet.12" ShapeID="_x0000_i1025" r:id="rIdNoLink" ' +
    'UpdateMode="Always"/></w:object>',
);
const FLOATING = para(
  '<w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="1" ' +
    'behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/>' +
    '<wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH>' +
    '<wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV>' +
    '<wp:extent cx="1270000" cy="635000"/><wp:effectExtent l="0" t="0" r="0" b="0"/>' +
    '<wp:wrapSquare wrapText="bothSides"/><wp:docPr id="1" name="Picture 1" descr="A picture"/>' +
    '<wp:cNvGraphicFramePr/><a:graphic><a:graphicData ' +
    'uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>' +
    '<pic:nvPicPr><pic:cNvPr id="0" name="p"/><pic:cNvPicPr/></pic:nvPicPr>' +
    '<pic:blipFill><a:blip r:embed="rIdNoImage"/></pic:blipFill><pic:spPr/></pic:pic>' +
    '</a:graphicData></a:graphic></wp:anchor></w:drawing>',
);
const TEXT_BOX = para(
  '<w:drawing><wp:inline><wp:extent cx="1270000" cy="635000"/><wp:docPr id="2" name="Box"/>' +
    '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
    '<wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr/><wps:txbx><w:txbxContent>' +
    '<w:p><w:r><w:t>Boxed</w:t></w:r></w:p></w:txbxContent></wps:txbx></wps:wsp>' +
    '</a:graphicData></a:graphic></wp:inline></w:drawing>',
);
const SHAPE = para(
  '<w:drawing><wp:inline><wp:extent cx="1270000" cy="635000"/><wp:docPr id="3" name="Shape"/>' +
    '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
    '<wps:wsp><wps:cNvSpPr/><wps:spPr><a:prstGeom prst="rect"/></wps:spPr></wps:wsp>' +
    '</a:graphicData></a:graphic></wp:inline></w:drawing>',
);
const NESTED_TABLE =
  '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid><w:tr><w:tc><w:tcPr/>' +
  '<w:p><w:r><w:t>outer</w:t></w:r></w:p>' +
  '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid><w:tr><w:tc>' +
  '<w:p><w:r><w:t>inner</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
  '<w:p/></w:tc></w:tr></w:tbl>';
const CONTENT_CONTROL =
  '<w:sdt><w:sdtPr><w:alias w:val="Unmapped"/><w:tag w:val="unmapped"/><w:unknownChild/></w:sdtPr>' +
  '<w:sdtContent><w:p><w:r><w:t>control</w:t></w:r></w:p></w:sdtContent></w:sdt>';

/** The body in source order, with the kind each block must become (its label, or its type). */
const BODY: Array<{ xml: string; kind: string }> = [
  { xml: INK, kind: 'ink' },
  { xml: ALTERNATE, kind: 'alternate content' },
  { xml: LINKED, kind: 'linked object' },
  { xml: FLOATING, kind: 'picture' },
  { xml: TEXT_BOX, kind: 'text box' },
  { xml: SHAPE, kind: 'shape' },
  { xml: NESTED_TABLE, kind: 'table' },
  { xml: CONTENT_CONTROL, kind: 'content control' },
];

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

interface Node {
  type: string;
  attrs?: Record<string, unknown>;
  content?: Node[];
}

/** The preserved atoms directly inside a node, depth first, with the nodes that hold them. */
function atomsIn(n: JsonNode | Node): Node[] {
  const out: Node[] = [];
  const stack: Node[] = [n as Node];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur.type === 'preserved_inline' || cur.type === 'preserved_block') out.push(cur);
    for (const c of cur.content ?? []) stack.push(c);
  }
  return out;
}

const labelOf = (n: Node): unknown => n.attrs?.['label'];

describe('EXP-117 criterion 1: each kind of content becomes a preserved atom in its original position', () => {
  it('a synthetic package holds each kind in the position of its source, with its label', async () => {
    const bytes = documentPackage(BODY.map((b) => b.xml).join(''));
    const { envelope } = await importDocx(bytes);
    const body = (envelope.doc as JsonNode).content!.find((n) => n.type === 'body')!
      .content as Node[];
    expect(body.length).toBe(BODY.length);

    for (const [i, expected] of BODY.entries()) {
      const block = body[i]!;
      if (expected.kind === 'table') {
        // The nested table is a preserved block inside the outer table's cell (outer, then nested).
        const cell = block.content![0]!.content![0]!;
        const inCell = cell.content!;
        const nested = inCell.find((c) => c.type === 'preserved_block');
        expect(labelOf(nested!), 'nested table').toBe('nested table');
        expect(inCell.indexOf(nested!), 'nested table after the outer text').toBe(1);
        continue;
      }
      if (expected.kind === 'content control') {
        expect(block.type).toBe('preserved_block');
        expect(labelOf(block), 'content control').toBe('content control');
        continue;
      }
      const atoms = atomsIn(block).filter((a) => labelOf(a) === expected.kind);
      expect(atoms.length, `block ${i} holds a ${expected.kind}`).toBeGreaterThan(0);
      // The atom keeps its fragment, and a drawn atom without a picture names its kind.
      for (const atom of atoms) {
        expect(typeof atom.attrs?.['fragment'], `${expected.kind} fragment`).toBe('string');
      }
    }
  });

  it('a floating picture keeps its wrap in its fragment and is also reported as a floating object', async () => {
    const { envelope, report } = await importDocx(documentPackage(FLOATING));
    const body = (envelope.doc as JsonNode).content!.find((n) => n.type === 'body')!
      .content as Node[];
    const atoms = atomsIn(body[0]!).filter((a) => labelOf(a) === 'picture');
    expect(atoms.length).toBe(1);
    expect(report.some((r) => r.kind === 'floating object' && r.count === 1)).toBe(true);
  });
});

describe('EXP-117 criterion 5: every preserved kind is reported as "preserved, not editable"', () => {
  it('each report line with the action preserved says so in its message, on every corpus file', async () => {
    let lines = 0;
    for (const file of corpusFiles()) {
      const { report } = await importDocx(readFile(file));
      for (const item of report) {
        if (item.action !== 'preserved') continue;
        lines++;
        expect(
          item.message.startsWith('preserved, not editable'),
          `${file.name} ${item.kind}`,
        ).toBe(true);
        expect(item.count).toBeGreaterThan(0);
      }
    }
    expect(lines).toBeGreaterThan(0);
  });
});

describe('EXP-117 criterion 1: the corpus holds the kinds the synthetic package stands for', () => {
  it('every kind of the list occurs as a preserved atom or block in the corpus', async () => {
    const seen = new Set<string>();
    for (const file of corpusFiles()) {
      const { envelope } = await importDocx(readFile(file));
      const stack: Node[] = [envelope.doc as Node];
      while (stack.length) {
        const n = stack.pop()!;
        if (n.type === 'preserved_inline' || n.type === 'preserved_block') {
          const label = labelOf(n);
          if (typeof label === 'string') seen.add(label);
        }
        for (const c of n.content ?? []) stack.push(c);
      }
    }
    for (const kind of [
      'text box',
      'shape',
      'chart',
      'SmartArt',
      'embedded object',
      'nested table',
      'content control',
    ]) {
      expect(seen.has(kind), `corpus holds ${kind}`).toBe(true);
    }
  });
});
