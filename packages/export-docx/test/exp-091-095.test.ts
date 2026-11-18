/**
 * The direct DOCX writer's remaining criteria of EXP-091 (tables, pictures, captions), EXP-093
 * (whole-table suggestions) and EXP-095 (form-field custom parts). Each test builds its own
 * document from the model's new document, writes it, and reads the package back as XML.
 */
import { describe, expect, it } from 'vitest';
import {
  computeLabels,
  newDocument,
  styleTable,
  type JsonEnvelope,
  type JsonMark,
  type JsonNode,
  type TreeNode,
} from '@docedit/model';
import { AssetStore, entryData, parseXml, readZip, type XmlElement } from '../src/index.ts';
import { writeDocx } from '../src/writer.ts';
import { makePng, nid, PNG } from './writer-docs.ts';

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
const att = (e: XmlElement | undefined, local: string): string | undefined =>
  e?.attrs.find((a) => a.local === local)?.value;
const kid = (e: XmlElement | undefined, local: string): XmlElement | undefined =>
  e?.children.find((c): c is XmlElement => c.kind === 'element' && c.local === local);
const xml = (text: string): XmlElement => parseXml(new TextEncoder().encode(text)).root;
/** Every character of text under an element, whatever its element (instruction text included). */
const rawText = (e: XmlElement): string =>
  e.children
    .map((c) => (c.kind === 'text' ? c.value : c.kind === 'element' ? rawText(c) : ''))
    .join('');
const textOf = (e: XmlElement): string =>
  all(e, 't')
    .map((t) => t.children.map((c) => (c.kind === 'text' ? c.value : '')).join(''))
    .join('');

/** Every XML part of a package, as text. */
function partsOf(bytes: Uint8Array): Map<string, string> {
  const zip = readZip(bytes);
  const out = new Map<string, string>();
  for (const e of zip.entries)
    if (/\.(xml|rels)$/.test(e.name)) out.set(e.name, new TextDecoder().decode(entryData(zip, e)));
  return out;
}

const t = (text: string, marks?: JsonMark[]): JsonNode =>
  marks ? { type: 'text', text, marks } : { type: 'text', text };
type Attrs = NonNullable<JsonNode['attrs']>;
const p = (content: JsonNode[], attrs: Record<string, unknown> = {}): JsonNode => ({
  type: 'paragraph',
  attrs: { id: nid('p'), ...attrs } as Attrs,
  content,
});
const cell = (content: JsonNode[], attrs: Record<string, unknown> = {}): JsonNode => ({
  type: 'table_cell',
  attrs: { id: nid('c'), ...attrs } as Attrs,
  content,
});
const row = (cells: JsonNode[], attrs: Record<string, unknown> = {}): JsonNode => ({
  type: 'table_row',
  attrs: { id: nid('r'), ...attrs } as Attrs,
  content: cells,
});
const bodyOf = (env: JsonEnvelope): JsonNode => env.doc.content!.find((n) => n.type === 'body')!;
const defsOf = (env: JsonEnvelope): JsonNode => env.doc.content!.find((n) => n.type === 'defs')!;

describe('the direct DOCX writer: rows, pictures, captions, suggestions and form parts', () => {
  it('writes a row taller than a page as one splittable Word row, with no continuation rows (EXP-091)', async () => {
    const env = newDocument();
    const lines = Array.from({ length: 200 }, (_, i) => p([t(`Line ${i}`)]));
    bodyOf(env).content = [
      {
        type: 'table',
        attrs: { id: nid('t'), grid: [4000] },
        content: [
          row([cell([p([t('short')])])]),
          row([cell(lines)]),
          row([cell([p([t('after')])])]),
        ],
      },
    ];
    const out = await writeDocx(env, new AssetStore());
    const body = xml(partsOf(out.bytes).get('word/document.xml')!);
    const rows = all(body, 'tr');
    // Three model rows, three Word rows: no row is split into continuation rows.
    expect(rows.length).toBe(3);
    expect(rows.map((r) => textOf(r))).toEqual([
      'short',
      lines.map((_, i) => `Line ${i}`).join(''),
      'after',
    ]);
    // The tall row may split across pages: it carries no cantSplit, and no other row does.
    expect(all(body, 'cantSplit').length).toBe(0);
    expect(all(rows[1]!, 'p').length).toBe(200);
    // A row that the model keeps together is still written so (the control).
    const kept = await writeDocx(
      (() => {
        const e = newDocument();
        bodyOf(e).content = [
          {
            type: 'table',
            attrs: { id: nid('t'), grid: [4000] },
            content: [row([cell([p([t('kept')])])], { cantSplit: true })],
          },
        ];
        return e;
      })(),
      new AssetStore(),
    );
    expect(all(xml(partsOf(kept.bytes).get('word/document.xml')!), 'cantSplit').length).toBe(1);
  });

  it('takes a picture only from the document assets, and writes an asset that is missing as its alternative text (EXP-091, I4)', async () => {
    const env = newDocument();
    const assets = new AssetStore();
    const attached = await assets.add(PNG, 'image/png', 'image');
    // A second asset in the store that no node of the document refers to.
    const unattached = makePng(8, 8);
    await assets.add(unattached, 'image/png', 'image');
    bodyOf(env).content = [
      {
        type: 'figure',
        attrs: { id: nid('f'), asset: attached, width: 720, height: 720, alt: 'Attached' },
        content: [],
      },
      {
        type: 'figure',
        attrs: {
          id: nid('f'),
          asset: 'ffffffffffffffffffffffffffffffff',
          width: 720,
          height: 720,
          alt: 'Missing picture',
        },
        content: [],
      },
    ];
    const out = await writeDocx(env, assets);
    const zip = readZip(out.bytes);
    const media = zip.entries.filter((e) => e.name.startsWith('word/media/'));
    // Only the referenced asset is written: one media part, with the attached bytes.
    expect(media.length).toBe(1);
    expect(Array.from(entryData(zip, media[0]!))).toEqual(Array.from(PNG));
    // The missing asset is not guessed: its alternative text is written and a warning says so.
    const body = xml(partsOf(out.bytes).get('word/document.xml')!);
    expect(textOf(body)).toContain('Missing picture');
    expect(out.warnings.some((w) => w.includes('asset is missing'))).toBe(true);
  });

  it('writes a figure with its alignment and alternative text, and its caption number equals the shared algorithm (EXP-091)', async () => {
    const env = newDocument();
    const assets = new AssetStore();
    const png = await assets.add(PNG, 'image/png', 'image');
    const figId = nid('f');
    const second = nid('f');
    bodyOf(env).content = [
      {
        type: 'figure',
        attrs: {
          id: figId,
          asset: png,
          width: 2880,
          height: 2880,
          alt: 'A figure',
          align: 'center',
        },
        content: [
          {
            type: 'caption',
            content: [
              t('Figure '),
              { type: 'field', attrs: { kind: 'seq', name: 'Figure' } },
              t(': the first'),
            ],
          },
        ],
      },
      {
        type: 'figure',
        attrs: { id: second, asset: png, width: 1440, height: 1440, alt: 'Second', align: 'end' },
        content: [
          {
            type: 'caption',
            content: [
              t('Figure '),
              { type: 'field', attrs: { kind: 'seq', name: 'Figure' } },
              t(': the second'),
            ],
          },
        ],
      },
    ];
    const labels = computeLabels(env.doc as unknown as TreeNode, {
      table: styleTable(env.doc as unknown as TreeNode),
    });
    const out = await writeDocx(env, assets);
    const body = xml(partsOf(out.bytes).get('word/document.xml')!);
    const paragraphs = all(body, 'p');
    // Alignment and alternative text of the first picture.
    const first = paragraphs.find((x) =>
      all(x, 'docPr').some((d) => att(d, 'descr') === 'A figure'),
    )!;
    expect(att(kid(kid(first, 'pPr'), 'jc'), 'val')).toBe('center');
    const second_ = paragraphs.find((x) =>
      all(x, 'docPr').some((d) => att(d, 'descr') === 'Second'),
    )!;
    expect(att(kid(kid(second_, 'pPr'), 'jc'), 'val')).toBe('right');
    // Caption numbers equal the shared algorithm's labels, and the SEQ fields carry them.
    const expectedFirst = labels.sequences.get(figId)![0]!.text;
    const expectedSecond = labels.sequences.get(second)![0]!.text;
    expect(expectedFirst).not.toBe(expectedSecond);
    const captions = paragraphs.filter((x) =>
      all(x, 'instrText').some((i) => rawText(i).includes('SEQ Figure')),
    );
    expect(captions.length).toBe(2);
    expect(textOf(captions[0]!)).toBe(`Figure ${expectedFirst}: the first`);
    expect(textOf(captions[1]!)).toBe(`Figure ${expectedSecond}: the second`);
  });

  it('writes an inline picture at its size with its alternative text, and the alignment of its paragraph (EXP-091)', async () => {
    const env = newDocument();
    const assets = new AssetStore();
    const png = await assets.add(PNG, 'image/png', 'image');
    bodyOf(env).content = [
      p(
        [
          t('Before '),
          {
            type: 'image',
            attrs: { asset: png, width: 1440, height: 720, alt: 'Inline & <small>' },
          },
          t(' after'),
        ],
        { align: 'center' },
      ),
    ];
    const out = await writeDocx(env, assets);
    const body = xml(partsOf(out.bytes).get('word/document.xml')!);
    const para = all(body, 'p')[0]!;
    // The picture shares the paragraph with its text: it is inline, not anchored.
    expect(all(para, 'inline').length).toBe(1);
    expect(all(para, 'anchor').length).toBe(0);
    expect(textOf(para)).toBe('Before  after');
    // Size in EMU is the size in twips times 635; the alternative text is read back unescaped.
    const extent = all(para, 'extent')[0]!;
    expect(att(extent, 'cx')).toBe(String(1440 * 635));
    expect(att(extent, 'cy')).toBe(String(720 * 635));
    expect(att(all(para, 'docPr')[0], 'descr')).toBe('Inline & <small>');
    // The model's inline image has no `align` (03 §4.4); its place on the line is its paragraph's.
    expect(att(kid(kid(para, 'pPr'), 'jc'), 'val')).toBe('center');
  });

  it('writes a whole-table suggestion as a tracked change on every row, with the commit date (EXP-093)', async () => {
    const env = newDocument();
    const cells = (s: string): JsonNode[] => [cell([p([t(s)])]), cell([p([t(`${s} 2`)])])];
    const del = { type: 'del', attrs: { id: 'delTable0001', user: 'user-0001' } };
    const ins = {
      type: 'ins',
      attrs: { id: 'insTable0002', user: 'word:Ada Lovelace' },
    };
    bodyOf(env).content = [
      {
        type: 'table',
        attrs: { id: nid('t'), grid: [3000, 3000], suggest: [del] },
        content: [row(cells('one')), row(cells('two'))],
      },
      {
        type: 'table',
        attrs: { id: nid('t'), grid: [3000, 3000], suggest: [ins] },
        content: [row(cells('three'))],
      },
    ];
    const out = await writeDocx(env, new AssetStore(), {
      suggestionDates: {
        delTable0001: '2026-11-03T09:00:00Z',
        insTable0002: '2026-11-04T09:30:00Z',
      },
    });
    const body = xml(partsOf(out.bytes).get('word/document.xml')!);
    const tables = all(body, 'tbl');
    const deleted = all(tables[0]!, 'tr');
    expect(deleted.length).toBe(2);
    for (const r of deleted) {
      const change = kid(kid(r, 'trPr'), 'del');
      expect(att(change, 'date')).toBe('2026-11-03T09:00:00Z');
      expect(att(change, 'author')).toBe('user-0001');
    }
    const inserted = all(tables[1]!, 'tr');
    expect(inserted.length).toBe(1);
    expect(att(kid(kid(inserted[0]!, 'trPr'), 'ins'), 'date')).toBe('2026-11-04T09:30:00Z');
    expect(att(kid(kid(inserted[0]!, 'trPr'), 'ins'), 'author')).toBe('Ada Lovelace');
  });

  it('keeps assignees and rules in a definitions part of their own, apart from the values (EXP-095)', async () => {
    const env = newDocument();
    env.requires = ['fields'];
    const defs = defsOf(env).content!;
    const at = defs.findIndex((n) => n.type === 'page_setup');
    defs.splice(
      at < 0 ? defs.length : at,
      0,
      { type: 'role_def', attrs: { id: 'tenant', name: 'Tenant', color: '#2E75B6' } },
      { type: 'rule_def', attrs: { id: 'adult', when: { op: 'gte', field: 'age', value: 18 } } },
    );
    bodyOf(env).content = [
      p([
        t('Name: '),
        {
          type: 'form_field',
          attrs: {
            id: nid('i'),
            key: 'tenant.name',
            kind: 'text',
            label: 'Name',
            assignee: 'tenant',
            value: 'Ann',
          },
        },
      ]),
    ];
    const out = await writeDocx(env, new AssetStore());
    const parts = partsOf(out.bytes);
    const definitions = [...parts.values()].filter((v) => v.includes('<f:definitions'));
    expect(definitions.length).toBe(1);
    expect(definitions[0]).toContain('<f:role id="tenant"');
    expect(definitions[0]).toContain('<f:rule id="adult"');
    const values = [...parts.values()].find((v) => v.includes('<f:fields'))!;
    expect(values).toContain('tenant.name');
    expect(values).not.toContain('<f:definitions');
    expect(values).not.toContain('<f:role');
    expect(values).not.toContain('<f:rule');
  });

  it("leaves a redacted form value out of every part of a requester's package, and names the redacted key (EXP-095)", async () => {
    const SECRET = 'classified-42-sentinel';
    const env = newDocument();
    env.requires = ['fields'];
    bodyOf(env).content = [
      p([
        t('Value: '),
        {
          type: 'form_field',
          attrs: {
            id: nid('i'),
            key: 'secret.value',
            kind: 'text',
            label: 'Secret',
            value: { redacted: true, value: SECRET },
          },
        },
      ]),
    ];
    const out = await writeDocx(env, new AssetStore());
    // No part of the package holds the value: not the values part, not the document.
    for (const [, text] of partsOf(out.bytes)) expect(text).not.toContain(SECRET);
    expect(out.redacted).toEqual(['secret.value']);
    const values = [...partsOf(out.bytes).values()].find((v) => v.includes('<f:fields'))!;
    expect(values).toContain('<f:field key="secret.value"></f:field>');
  });
});
