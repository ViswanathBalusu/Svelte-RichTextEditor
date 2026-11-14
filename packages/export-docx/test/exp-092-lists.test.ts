/**
 * EXP-092 criterion 3: a list of figures or tables, bookmarks and cross-references are fields,
 * and the labels they show equal the shared algorithm's (`computeLabels`, `referenceText`).
 * Each test builds its own document, writes it, and reads the package back as XML.
 */
import { describe, expect, it } from 'vitest';
import {
  computeLabels,
  newDocument,
  referenceText,
  styleTable,
  type JsonEnvelope,
  type JsonNode,
  type TreeNode,
} from '@docedit/model';
import { AssetStore, entryData, parseXml, readZip, type XmlElement } from '../src/index.ts';
import { writeDocx } from '../src/writer.ts';
import { nid, PNG } from './writer-docs.ts';

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
const xml = (text: string): XmlElement => parseXml(new TextEncoder().encode(text)).root;
const rawText = (e: XmlElement): string =>
  e.children
    .map((c) => (c.kind === 'text' ? c.value : c.kind === 'element' ? rawText(c) : ''))
    .join('');
/** The visible text of a paragraph: its `w:t` runs, in order (field results included). */
const textOf = (e: XmlElement): string =>
  all(e, 't')
    .map((t) => t.children.map((c) => (c.kind === 'text' ? c.value : '')).join(''))
    .join('');

function partsOf(bytes: Uint8Array): Map<string, string> {
  const zip = readZip(bytes);
  const out = new Map<string, string>();
  for (const e of zip.entries)
    if (/\.(xml|rels)$/.test(e.name)) out.set(e.name, new TextDecoder().decode(entryData(zip, e)));
  return out;
}

const t = (text: string): JsonNode => ({ type: 'text', text });
type Attrs = NonNullable<JsonNode['attrs']>;
const p = (content: JsonNode[], attrs: Record<string, unknown> = {}): JsonNode => ({
  type: 'paragraph',
  attrs: { id: nid('p'), ...attrs } as Attrs,
  content,
});
const bodyOf = (env: JsonEnvelope): JsonNode => env.doc.content!.find((n) => n.type === 'body')!;

describe('EXP-092 criterion 3: lists of figures and tables show the shared labels', () => {
  it('writes each list-of-figures entry with the caption label computeLabels gives it', async () => {
    const env = newDocument();
    const assets = new AssetStore();
    const png = await assets.add(PNG, 'image/png', 'image');
    const figures = [nid('f'), nid('f'), nid('f')];
    const captions = ['the first', 'the second', 'the third'];
    bodyOf(env).content = [
      { type: 'toc', attrs: { id: nid('c'), of: 'Figure' } },
      ...figures.map((id, i) => ({
        type: 'figure',
        attrs: { id, asset: png, width: 1440, height: 1440, alt: `F${i}` },
        content: [
          {
            type: 'caption',
            content: [
              t('Figure '),
              { type: 'field', attrs: { kind: 'seq', name: 'Figure' } },
              t(`: ${captions[i]}`),
            ],
          },
        ],
      })),
    ];
    const labels = computeLabels(env.doc as unknown as TreeNode, {
      table: styleTable(env.doc as unknown as TreeNode),
    });
    const expected = figures.map((id) => labels.sequences.get(id)![0]!.text);
    expect(new Set(expected).size).toBe(3);

    const out = await writeDocx(env, assets);
    const body = xml(partsOf(out.bytes).get('word/document.xml')!);
    const instr = all(body, 'instrText').find((i) => rawText(i).includes('TOC'))!;
    expect(rawText(instr)).toContain('\\c "Figure"');
    // The list entries are the paragraphs of the TOC field, before its end.
    const entries = all(body, 'p').filter(
      (x) => textOf(x).startsWith('Figure ') && textOf(x).includes(': '),
    );
    const shown = entries.map(textOf);
    for (let i = 0; i < 3; i++) expect(shown[i]).toBe(`Figure ${expected[i]}: ${captions[i]}`);
    // The figure captions themselves carry the same labels.
    const captionTexts = all(body, 'p')
      .filter((x) => all(x, 'instrText').some((i) => rawText(i).includes('SEQ Figure')))
      .map(textOf);
    expect(captionTexts).toEqual(expected.map((e, i) => `Figure ${e}: ${captions[i]}`));
  });

  it('writes a cross-reference with the label referenceText gives its target', async () => {
    const env = newDocument();
    const figId = nid('f');
    const table: JsonNode = {
      type: 'table',
      attrs: { id: nid('t') },
      content: [
        {
          type: 'table_row',
          attrs: { id: nid('r') },
          content: [
            {
              type: 'table_cell',
              attrs: { id: nid('c') },
              content: [p([t('cell')])],
            },
          ],
        },
      ],
    };
    bodyOf(env).content = [
      {
        type: 'figure',
        attrs: { id: figId, width: 1440, height: 1440, alt: 'F' },
        content: [
          {
            type: 'caption',
            content: [
              t('Figure '),
              { type: 'field', attrs: { kind: 'seq', name: 'Figure' } },
              t(': the only'),
            ],
          },
        ],
      },
      p([
        t('See '),
        { type: 'field', attrs: { kind: 'ref', target: `node:${figId}`, cached: 'stale' } },
        t('.'),
      ]),
      table,
    ];
    const labels = computeLabels(env.doc as unknown as TreeNode, {
      table: styleTable(env.doc as unknown as TreeNode),
    });
    const label = referenceText(labels, `node:${figId}`);
    expect(label).not.toBeNull();
    expect(label).not.toBe('stale');

    const out = await writeDocx(env, new AssetStore());
    const body = xml(partsOf(out.bytes).get('word/document.xml')!);
    const ref = all(body, 'instrText').find((i) => rawText(i).includes('REF'));
    expect(ref).toBeDefined();
    const paragraph = all(body, 'p').find((x) => textOf(x).startsWith('See '))!;
    expect(textOf(paragraph)).toBe(`See ${label}.`);
  });
});
