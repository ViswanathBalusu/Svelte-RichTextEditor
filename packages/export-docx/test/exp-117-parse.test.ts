/**
 * EXP-117, criterion 4: when a fragment is stored, nothing in it is parsed beyond the package
 * structure, or executed.
 *
 * Reading used (proposed in docs/adr/0386-w2-exp-117-118-122.md): the package structure is the ZIP
 * directory, `[Content_Types].xml` and the relationship parts (`.rels`). A part that a fragment
 * relates to (a chart, an embedded object, a drawing) is copied as bytes and never parsed. The
 * atom's own XML is a slice of the bytes of its host part; storing it does not parse it again.
 *
 * The synthetic package relates an atom to parts that no XML parser accepts (malformed markup, a
 * DOCTYPE with entities that the importer's parser refuses, binary data with a script in it). If the
 * importer parsed any of them, the import would fail with an `ImportError`. It must succeed, keep
 * each part byte for byte, and run nothing: `fetch`, `XMLHttpRequest` and `WebSocket` are
 * replaced by stubs that record a call, and the script text in a part sets a global if it ever runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JsonNode } from '@docedit/model';
import {
  entryData,
  importDocx,
  readFragment,
  readZip,
  writeZip,
  type ZipWriteEntry,
} from '../src/index.ts';
import { corpusFiles, readFile } from './corpus.ts';

const SAMPLE = corpusFiles().find((f) => f.name === 'docx4j/sample-docx.docx')!;
const enc = new TextEncoder();
const dec = new TextDecoder();

const NAMESPACES = [
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"',
].join(' ');

const CHART_BODY =
  '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="1270000" cy="635000"/>' +
  '<wp:docPr id="1" name="Chart 1"/><a:graphic>' +
  '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">' +
  '<c:chart r:id="rIdHostile1"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** Parts no XML parser accepts, and one that carries markup that would run if anything did. */
const HOSTILE: Array<{ name: string; bytes: Uint8Array }> = [
  { name: 'word/charts/chart1.xml', bytes: enc.encode('<c:chartSpace><<< not xml & unclosed') },
  {
    name: 'word/charts/chart2.xml',
    bytes: enc.encode(
      '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;">]>' +
        '<c:chartSpace xmlns:c="urn:x">&b;&b;&b;</c:chartSpace>',
    ),
  },
  {
    name: 'word/embeddings/object1.bin',
    bytes: Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xff, 0xfe, 0x00, 0x3c, 0x73, 0x63, 0x72, 0x69]),
  },
  {
    name: 'word/embeddings/script1.xml',
    bytes: enc.encode('<script>globalThis.__ran = true; eval("globalThis.__ran = true")</script>'),
  },
];

function hostilePackage(): Uint8Array {
  const zip = readZip(readFile(SAMPLE));
  const doc =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${NAMESPACES}><w:body>` +
    `${CHART_BODY}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`;
  const relsName = 'word/_rels/document.xml.rels';
  const relsEntry = zip.byName.get(relsName)!;
  const rels = dec
    .decode(entryData(zip, relsEntry))
    .replace(
      '</Relationships>',
      `<Relationship Id="rIdHostile1" Type="${REL}/chart" Target="charts/chart1.xml"/></Relationships>`,
    );
  const entries: ZipWriteEntry[] = zip.entries.map((e) =>
    e.name === 'word/document.xml'
      ? { name: e.name, data: enc.encode(doc), like: e }
      : e.name === relsName
        ? { name: e.name, data: enc.encode(rels), like: e }
        : { name: e.name, copyOf: e, from: zip },
  );
  // The chart relates to the other three parts through its own relationship part (package
  // structure, which is parsed); the parts themselves are not.
  entries.push({ name: HOSTILE[0]!.name, data: HOSTILE[0]!.bytes });
  const chartRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    `<Relationship Id="rId1" Type="${REL}/chart" Target="chart2.xml"/>` +
    `<Relationship Id="rId2" Type="${REL}/oleObject" Target="../embeddings/object1.bin"/>` +
    `<Relationship Id="rId3" Type="${REL}/package" Target="../embeddings/script1.xml"/>` +
    `<Relationship Id="rId4" Type="${REL}/hyperlink" Target="https://example.invalid/never" TargetMode="External"/>` +
    '</Relationships>';
  entries.push({ name: 'word/charts/_rels/chart1.xml.rels', data: enc.encode(chartRels) });
  for (const h of HOSTILE.slice(1)) entries.push({ name: h.name, data: h.bytes });
  return writeZip(entries);
}

const CALLS: string[] = [];

beforeEach(() => {
  CALLS.length = 0;
  const record =
    (name: string) =>
    (..._args: unknown[]): never => {
      CALLS.push(name);
      throw new Error(`${name} must not be called during import`);
    };
  for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket'])
    vi.stubGlobal(name, record(name));
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as { __ran?: boolean }).__ran;
});

const findAtoms = (n: JsonNode, out: JsonNode[] = []): JsonNode[] => {
  if (n.type.startsWith('preserved') && n.attrs?.['label'] === 'chart') out.push(n);
  for (const c of n.content ?? []) findAtoms(c, out);
  return out;
};

describe('EXP-117 criterion 4: a stored fragment is not parsed beyond the package structure', () => {
  it('imports a chart whose parts no XML parser accepts, and keeps every part byte for byte', async () => {
    const result = await importDocx(hostilePackage());
    const atoms = findAtoms(result.envelope.doc);
    expect(atoms.length).toBe(1);
    const asset = result.assets.get(String(atoms[0]!.attrs?.['fragment']));
    expect(asset?.role).toBe('fragment');
    const fragment = readFragment(asset!.bytes);
    const inner = readZip(asset!.bytes);
    for (const h of HOSTILE) {
      expect(
        fragment.meta.parts.some((p) => p.name === h.name),
        `${h.name} is carried`,
      ).toBe(true);
      const entry = inner.byName.get(`parts/${h.name}`);
      expect(entry, `${h.name} is in the fragment`).toBeDefined();
      expect(entryData(inner, entry!), `${h.name} byte for byte`).toEqual(h.bytes);
    }
  });

  it('keeps the external relationship of the chart as data and executes and fetches nothing', async () => {
    const result = await importDocx(hostilePackage());
    const atom = findAtoms(result.envelope.doc)[0]!;
    const fragment = readFragment(result.assets.get(String(atom.attrs?.['fragment']))!.bytes);
    // The chart's own relationship part is package structure: the external target is read as data
    // there, and no part is made for it.
    expect(fragment.meta.parts.some((p) => p.name.includes('example.invalid'))).toBe(false);
    expect(CALLS).toEqual([]);
    expect((globalThis as { __ran?: boolean }).__ran).toBeUndefined();
  });
});
