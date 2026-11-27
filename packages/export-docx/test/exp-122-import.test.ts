/**
 * EXP-122 criteria 2 and 3: a Word file with citations and a bibliography is imported as source
 * definitions and citation nodes, and written back under R0 and R1 of ADR 0017. The two files in
 * `corpus/word/` were made by Microsoft Word 16 itself (Word's own sources part, its own
 * `w:citation` content controls and its own switches), see corpus/SOURCES.md. The generic corpus
 * tests (roundtrip, edits) run on them as well.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { JsonEnvelope, JsonNode } from '@docedit/model';
import { validate } from '@docedit/model/validate';
import {
  checkR0,
  entryData,
  exportDocx,
  importDocx,
  parseXml,
  readZip,
  type XmlElement,
} from '../src/index.ts';
import { writeZip } from '../src/zip.ts';

const load = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`../corpus/word/${name}`, import.meta.url)));

function* walk(n: JsonNode): Generator<JsonNode> {
  yield n;
  for (const c of n.content ?? []) yield* walk(c);
}
const nodesOf = (env: JsonEnvelope, type: string): JsonNode[] =>
  [...walk(env.doc as unknown as JsonNode)].filter((n) => n.type === type);

type Imported = Awaited<ReturnType<typeof importDocx>>;

/** The identifiers of an import are fresh; the tag Word cites a source by is in the source map. */
const tagOf = (imp: Imported, id: unknown): string => imp.sourceMap.defs[String(id)]!.wordId!;
const sourcesByTag = (imp: Imported): Map<string, JsonNode> =>
  new Map(nodesOf(imp.envelope, 'source_def').map((s) => [tagOf(imp, s.attrs?.['id']), s]));
/** The items of a citation with each source named by its tag. */
const citedTags = (imp: Imported, c: JsonNode): unknown =>
  (c.attrs?.['items'] as Array<Record<string, unknown>>).map((i) => ({
    ...i,
    source: tagOf(imp, i['source']),
  }));

const partText = (bytes: Uint8Array, name: string): string => {
  const zip = readZip(bytes);
  return new TextDecoder().decode(entryData(zip, zip.byName.get(name)!));
};
const xml = (text: string): XmlElement => parseXml(new TextEncoder().encode(text)).root;
const all = (root: XmlElement, local: string): XmlElement[] => {
  const out: XmlElement[] = [];
  const stack = [root];
  while (stack.length) {
    const e = stack.pop()!;
    if (e.local === local) out.push(e);
    for (let i = e.children.length - 1; i >= 0; i--) {
      const c = e.children[i]!;
      if (c.kind === 'element') stack.push(c);
    }
  }
  return out;
};
const rawText = (e: XmlElement): string =>
  e.children
    .map((c) => (c.kind === 'text' ? c.value : c.kind === 'element' ? rawText(c) : ''))
    .join('');

const SOURCES_PART = 'customXml/item1.xml';

describe('EXP-122 criterion 2: Word sources become source definitions', () => {
  it('reads every source of a Word file with the fields the model has', async () => {
    const imported = await importDocx(load('citations.docx'));
    const sources = sourcesByTag(imported);
    expect([...sources.keys()]).toEqual(['Smi20', 'Lee19']);
    const [smith, lee] = [sources.get('Smi20'), sources.get('Lee19')];
    expect(smith!.attrs).toMatchObject({
      kind: 'book',
      title: 'Notes on Editors',
      authors: [{ family: 'Smith', given: 'Ada' }],
      issued: '2020',
      publisherPlace: 'London',
      publisher: 'Example Press',
    });
    expect(lee!.attrs).toMatchObject({
      kind: 'article-journal',
      title: 'Fields in Word Documents',
      authors: [{ family: 'Lee', given: 'Sam' }],
      issued: '2019',
      containerTitle: 'Journal of Examples',
      volume: '4',
      pages: '10-20',
    });
    expect(
      validate(imported.envelope, { attachedAssets: imported.assets.ids() }).violations,
    ).toEqual([]);
  });

  it('reads each citation field as a citation node of its sources', async () => {
    const imported = await importDocx(load('citations.docx'));
    const cites = nodesOf(imported.envelope, 'citation');
    expect(cites.map((c) => citedTags(imported, c))).toEqual([
      [{ source: 'Smi20' }],
      [{ source: 'Lee19' }, { source: 'Smi20' }],
      [{ source: 'Smi20' }],
    ]);
    // The identifiers are the import's own, and each is a source of the document.
    const ids = new Set(nodesOf(imported.envelope, 'source_def').map((s) => s.attrs?.['id']));
    for (const c of cites)
      for (const i of c.attrs?.['items'] as Array<{ source: string }>)
        expect(ids.has(i.source)).toBe(true);
    expect(cites.map((c) => c.attrs?.['mode'])).toEqual(['normal', 'normal', 'suppressAuthor']);
    expect(cites.map((c) => c.attrs?.['cached'])).toEqual([
      '(Smith, 2020)',
      '(Lee, 2019; Smith, 2020)',
      '(Notes on Editors, 2020)',
    ]);
    // Each keeps its original content control while unedited.
    for (const c of cites) expect(c.attrs?.['origin']).toBeTruthy();
    // The bibliography field is not a model node: it stays preserved content.
    expect(nodesOf(imported.envelope, 'bibliography')).toEqual([]);
  });

  it('keeps R0: an imported file with citations is written back byte for byte', async () => {
    for (const name of ['citations.docx', 'citations-rich.docx']) {
      const bytes = load(name);
      const imported = await importDocx(bytes);
      const out = await exportDocx(imported.envelope, bytes, imported.sourceMap, imported.assets);
      const r0 = checkR0(bytes, out.bytes);
      expect(r0.diff.changed, name).toEqual([]);
      expect(out.regenerated, name).toEqual([]);
      expect(out.bytes, name).toEqual(bytes);
    }
  });

  it('keeps a citation of a source the file does not define as a preserved content control', async () => {
    // The source Lee19 is renamed in the sources part, so the second citation names no source.
    const original = load('citations.docx');
    const zip = readZip(original);
    const renamed = partText(original, SOURCES_PART).replace(
      '<b:Tag>Lee19</b:Tag>',
      '<b:Tag>Gone19</b:Tag>',
    );
    const bytes = writeZip(
      zip.entries.map((e) =>
        e.name === SOURCES_PART
          ? { name: e.name, data: new TextEncoder().encode(renamed), like: e }
          : { name: e.name, copyOf: e, from: zip },
      ),
    );
    const imported = await importDocx(bytes);
    const cites = nodesOf(imported.envelope, 'citation');
    expect(cites.map((c) => citedTags(imported, c))).toEqual([
      [{ source: 'Smi20' }],
      [{ source: 'Smi20' }],
    ]);
    expect(
      nodesOf(imported.envelope, 'preserved_inline').some(
        (n) => n.attrs?.['label'] === 'content control',
      ),
    ).toBe(true);
    // Still lossless.
    const out = await exportDocx(imported.envelope, bytes, imported.sourceMap, imported.assets);
    expect(out.bytes).toEqual(bytes);
  });
});

describe('EXP-122 criterion 3: what the model does not represent is kept', () => {
  it('keeps the switches of a field and the elements of a source the model has no place for', async () => {
    const imported = await importDocx(load('citations-rich.docx'));
    const byId = Object.fromEntries([...sourcesByTag(imported)].map(([tag, s]) => [tag, s.attrs!]));
    expect(Object.keys(byId)).toEqual(['Ito21', 'WG22', 'Art23']);
    // A middle name is not modelled, so the contributors stay as they were.
    expect(byId['Ito21']).toMatchObject({
      kind: 'chapter',
      title: 'Fragments of Layout',
      containerTitle: 'Collected Essays on Pages',
      issued: '2021',
      publisher: 'Harbour House',
      publisherPlace: 'Osaka',
      pages: '55-80',
      note: 'Chapter 4',
    });
    expect(byId['Ito21']!['authors']).toBeUndefined();
    const kept = (a: Record<string, unknown>): string[] =>
      ((a['preserved'] as { children?: Array<{ name: string }> }).children ?? []).map((c) =>
        c.name.replace(/^\{[^}]*\}/, ''),
      );
    expect(kept(byId['Ito21']!)).toEqual(['Author', 'Month', 'Day', 'RefOrder']);
    expect(byId['WG22']).toMatchObject({
      kind: 'report',
      authors: [{ literal: 'Working Group on Fields' }],
      url: 'https://example.org/report',
    });
    expect(kept(byId['WG22']!)).toEqual(['RefOrder']);
    // A source type the writer would change stays as the file had it.
    expect(byId['Art23']!['kind']).toBe('document');
    expect(kept(byId['Art23']!)).toEqual(['SourceType', 'RefOrder']);

    const cites = nodesOf(imported.envelope, 'citation');
    expect(cites.map((c) => citedTags(imported, c))).toEqual([
      [{ source: 'Ito21', locator: '57', label: 'page' }],
      [{ source: 'WG22' }],
      [{ source: 'Art23' }, { source: 'Ito21' }],
    ]);
    const residual = (c: JsonNode): string | null => {
      const p = c.attrs?.['preserved'] as {
        children?: Array<{ children?: Array<{ text: string }> }>;
      };
      return p?.children?.[0]?.children?.[0]?.text ?? null;
    };
    expect(cites.map(residual)).toEqual([null, '\\l 2057', '\\y']);
  });

  it('writes an unedited source and the root of the part back as they were when another source changes', async () => {
    const bytes = load('citations-rich.docx');
    const imported = await importDocx(bytes);
    const env = structuredClone(imported.envelope);
    const wgId = sourcesByTag(imported).get('WG22')!.attrs!['id'];
    const wg = nodesOf(env, 'source_def').find((s) => s.attrs?.['id'] === wgId)!;
    wg.attrs!['title'] = 'Field Codes in Practice, Second Edition';
    const out = await exportDocx(env, bytes, imported.sourceMap, imported.assets);

    const before = partText(bytes, SOURCES_PART);
    const after = partText(out.bytes, SOURCES_PART);
    // The root, with its style properties, is the original's.
    const root = (t: string): string => t.slice(0, t.indexOf('<b:Source>'));
    expect(root(after)).toBe(root(before));
    expect(root(after)).toContain('SelectedStyle="\\CHICAGO.XSL"');
    expect(root(after)).toContain('StyleName="Chicago"');
    expect(root(after)).toContain('Version="16"');
    // The two sources not touched are the original's bytes.
    const sourceOf = (t: string, tag: string): string => {
      const at = t.indexOf(`<b:Tag>${tag}</b:Tag>`);
      return t.slice(t.lastIndexOf('<b:Source', at), t.indexOf('</b:Source>', at) + 11);
    };
    expect(sourceOf(after, 'Ito21')).toBe(sourceOf(before, 'Ito21'));
    expect(sourceOf(after, 'Art23')).toBe(sourceOf(before, 'Art23'));
    // The changed one has the new title and keeps what the model has no place for.
    const wgXml = sourceOf(after, 'WG22');
    expect(wgXml).toContain('<b:Title>Field Codes in Practice, Second Edition</b:Title>');
    expect(wgXml).toContain('<b:RefOrder>2</b:RefOrder>');
    expect(wgXml).toContain('<b:Corporate>Working Group on Fields</b:Corporate>');
    // The part is still well formed, and no other part changed.
    expect(all(xml(after), 'Source').length).toBe(3);
    expect(Object.entries(out.parts).filter(([, m]) => m !== 'copied')).toEqual([
      [SOURCES_PART, expect.any(String)],
    ]);

    // Imported again, the edit is there and the rest is as it was.
    const again = await importDocx(out.bytes);
    const wg2 = sourcesByTag(again).get('WG22')!;
    expect(wg2.attrs).toMatchObject({
      title: 'Field Codes in Practice, Second Edition',
      authors: [{ literal: 'Working Group on Fields' }],
    });
  });

  it('writes a new source and drops a deleted one', async () => {
    const bytes = load('citations.docx');
    const imported = await importDocx(bytes);
    const env = structuredClone(imported.envelope);
    const defs = env.doc.content!.find((n) => n.type === 'defs')!;
    const leeId = sourcesByTag(imported).get('Lee19')!.attrs!['id'];
    defs.content = defs.content!.filter((n) => n.attrs?.['id'] !== leeId);
    defs.content.push({
      type: 'source_def',
      attrs: { id: 'New24', kind: 'webpage', title: 'A Page', issued: '2024' },
    });
    // The second citation cites the deleted source: drop it from the document first.
    for (const c of nodesOf(env, 'citation'))
      c.attrs!['items'] = (c.attrs!['items'] as Array<{ source: string }>).filter(
        (i) => i.source !== leeId,
      );
    const out = await exportDocx(env, bytes, imported.sourceMap, imported.assets);
    const tags = all(xml(partText(out.bytes, SOURCES_PART)), 'Tag').map(rawText);
    expect(tags).toEqual(['Smi20', 'New24']);
    expect(partText(out.bytes, SOURCES_PART)).toContain(
      '<b:SourceType>InternetSite</b:SourceType>',
    );
  });
});

describe('EXP-122: an edited citation is written from the model', () => {
  it('keeps the unmodelled switches and leaves the other citations as they were', async () => {
    const bytes = load('citations-rich.docx');
    const imported = await importDocx(bytes);
    const env = structuredClone(imported.envelope);
    const cites = nodesOf(env, 'citation');
    cites[1]!.attrs!['mode'] = 'suppressAuthor';
    cites[1]!.attrs!['cached'] = '(2022)';
    const out = await exportDocx(env, bytes, imported.sourceMap, imported.assets);

    const before = partText(bytes, 'word/document.xml');
    const after = partText(out.bytes, 'word/document.xml');
    const instr = all(xml(after), 'instrText').map((i) => rawText(i));
    expect(instr).toEqual([
      ' CITATION Ito21 \\l 1033 \\p 57 ',
      ' CITATION WG22 \\n \\l 2057 ',
      ' CITATION Art23 \\l 1033 \\m Ito21 \\y ',
    ]);
    // The first and the third control are the original's bytes.
    const controls = (t: string): string[] => t.match(/<w:sdt>.*?<\/w:sdt>/gs) ?? [];
    expect(controls(after)[0]).toBe(controls(before)[0]);
    expect(controls(after)[2]).toBe(controls(before)[2]);
    expect(controls(after)[1]).toContain('<w:citation/>');
    expect(controls(after)[1]).toContain('(2022)');

    const again = await importDocx(out.bytes);
    const edited = nodesOf(again.envelope, 'citation')[1]!;
    expect(edited.attrs).toMatchObject({ mode: 'suppressAuthor', cached: '(2022)' });
    expect(citedTags(again, edited)).toEqual([{ source: 'WG22' }]);
  });
});

describe('EXP-122: our own writer and importer agree', () => {
  it('imports the citations the direct writer writes', async () => {
    const { writeDocx } = await import('../src/writer.ts');
    const { AssetStore } = await import('../src/index.ts');
    const { newDocument } = await import('@docedit/model');
    const env = newDocument();
    const defs = env.doc.content!.find((n) => n.type === 'defs')!;
    defs.content!.push({
      type: 'source_def',
      attrs: {
        id: 'smith2020',
        kind: 'book',
        title: 'A Book',
        authors: [{ family: 'Smith', given: 'Ada' }],
        editors: [{ family: 'Brown', given: 'Pat' }],
        issued: '2020',
      },
    });
    const body = env.doc.content!.find((n) => n.type === 'body')!;
    body.content = [
      {
        type: 'paragraph',
        attrs: { id: 'p1' },
        content: [
          { type: 'text', text: 'See ' },
          {
            type: 'citation',
            attrs: {
              items: [{ source: 'smith2020', locator: '12', label: 'page' }],
              mode: 'normal',
              cached: '(Smith 2020, 12)',
            },
          },
        ],
      },
    ] as JsonNode[];
    const written = await writeDocx(env, new AssetStore());
    const imported = await importDocx(written.bytes);
    const source = nodesOf(imported.envelope, 'source_def')[0]!;
    expect(tagOf(imported, source.attrs?.['id'])).toBe('smith2020');
    expect(source.attrs).toMatchObject({
      kind: 'book',
      authors: [{ family: 'Smith', given: 'Ada' }],
      editors: [{ family: 'Brown', given: 'Pat' }],
    });
    const cite = nodesOf(imported.envelope, 'citation')[0]!;
    expect(cite.attrs).toMatchObject({ cached: '(Smith 2020, 12)' });
    expect(citedTags(imported, cite)).toEqual([
      { source: 'smith2020', locator: '12', label: 'page' },
    ]);
  });
});
