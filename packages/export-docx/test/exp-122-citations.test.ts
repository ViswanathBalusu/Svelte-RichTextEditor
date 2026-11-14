/**
 * EXP-122 criterion 1 (direct writer): a citation becomes a Word citation field, and the document's
 * sources become the package's bibliography sources part (a custom XML item with the `b:Sources`
 * namespace, referenced from the document). Each test writes its own document and reads the package
 * back as XML. Word itself is not run here: the field shape and the part's shape are checked, not
 * that Word updates them (docs/stories/EXP-export.md, EXP-122 Notes).
 */
import { describe, expect, it } from 'vitest';
import { newDocument, type JsonEnvelope, type JsonNode } from '@docedit/model';
import { AssetStore, entryData, parseXml, readZip, type XmlElement } from '../src/index.ts';
import { writeDocx } from '../src/writer.ts';
import { nid } from './writer-docs.ts';

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

function partsOf(bytes: Uint8Array): Map<string, string> {
  const zip = readZip(bytes);
  const out = new Map<string, string>();
  for (const e of zip.entries)
    if (/\.(xml|rels)$/.test(e.name)) out.set(e.name, new TextDecoder().decode(entryData(zip, e)));
  return out;
}

const t = (text: string): JsonNode => ({ type: 'text', text });
const bodyOf = (env: JsonEnvelope): JsonNode => env.doc.content!.find((n) => n.type === 'body')!;

/** The defs node of the envelope, created when the document has none. */
function defsOf(env: JsonEnvelope): JsonNode {
  const content = env.doc.content!;
  let d = content.find((n) => n.type === 'defs');
  if (!d) {
    d = { type: 'defs', content: [] };
    content.push(d);
  }
  d.content = d.content ?? [];
  return d;
}

const smith: JsonNode = {
  type: 'source_def',
  attrs: {
    id: 'smith2020',
    kind: 'book',
    title: 'A Book of Things',
    authors: [{ family: 'Smith', given: 'Ada' }],
    issued: '2020-05-01',
    publisher: 'Press',
    publisherPlace: 'Leeds',
  },
};
const jones: JsonNode = {
  type: 'source_def',
  attrs: {
    id: 'jones2021',
    kind: 'article-journal',
    title: 'On Articles',
    authors: [{ literal: 'The Working Group' }],
    issued: '2021',
    containerTitle: 'Journal of Tests',
    volume: '4',
    pages: '10-20',
  },
};

function citationPara(
  items: Array<{ source: string }>,
  cached: string | null,
  mode = 'normal',
): JsonNode {
  return {
    type: 'paragraph',
    attrs: { id: nid('p') },
    content: [t('See '), { type: 'citation', attrs: { items, mode, cached } }, t('.')],
  };
}

/** The `instrText` values of a document part, as their text. */
const instructions = (body: XmlElement): string[] => all(body, 'instrText').map((i) => rawText(i));

describe('EXP-122 criterion 1: citations are Word citation fields', () => {
  it('writes a citation as a complex CITATION field whose result is the cached text', async () => {
    const env = newDocument();
    defsOf(env).content!.push(smith);
    bodyOf(env).content = [citationPara([{ source: 'smith2020' }], '(Smith, 2020)')];
    const out = await writeDocx(env, new AssetStore());
    const body = xml(partsOf(out.bytes).get('word/document.xml')!);
    expect(instructions(body)).toEqual([' CITATION smith2020 \\l 1033 ']);
    const types = all(body, 'fldChar').map(
      (f) => f.attrs.find((a) => a.local === 'fldCharType')?.value,
    );
    expect(types).toEqual(['begin', 'separate', 'end']);
    const runs = all(body, 't').map(rawText);
    expect(runs).toContain('(Smith, 2020)');
    expect(runs.join('')).toContain('See (Smith, 2020).');
  });

  it('adds a further source of one citation with the \\m switch', async () => {
    const env = newDocument();
    defsOf(env).content!.push(smith, jones);
    bodyOf(env).content = [
      citationPara(
        [{ source: 'smith2020' }, { source: 'jones2021' }],
        '(Smith, 2020; Working Group, 2021)',
      ),
    ];
    const out = await writeDocx(env, new AssetStore());
    const body = xml(partsOf(out.bytes).get('word/document.xml')!);
    expect(instructions(body)).toEqual([' CITATION smith2020 \\l 1033 \\m jones2021 ']);
  });

  it('adds \\n for a citation that suppresses the author', async () => {
    const env = newDocument();
    defsOf(env).content!.push(smith);
    bodyOf(env).content = [citationPara([{ source: 'smith2020' }], '(2020)', 'suppressAuthor')];
    const out = await writeDocx(env, new AssetStore());
    const body = xml(partsOf(out.bytes).get('word/document.xml')!);
    expect(instructions(body)).toEqual([' CITATION smith2020 \\l 1033 \\n ']);
  });

  it('writes the cached text from the citation items when there is none', async () => {
    const env = newDocument();
    defsOf(env).content!.push(smith);
    bodyOf(env).content = [citationPara([{ source: 'smith2020' }], null)];
    const out = await writeDocx(env, new AssetStore());
    const body = xml(partsOf(out.bytes).get('word/document.xml')!);
    expect(all(body, 't').map(rawText)).toContain('[smith2020]');
  });

  it('writes a citation with no usable tag as its text only, and says so', async () => {
    const env = newDocument();
    bodyOf(env).content = [citationPara([{ source: 'not a tag!' }], '(Nobody)')];
    const out = await writeDocx(env, new AssetStore());
    const body = xml(partsOf(out.bytes).get('word/document.xml')!);
    expect(instructions(body)).toEqual([]);
    expect(all(body, 't').map(rawText)).toContain('(Nobody)');
    expect(out.warnings.some((w) => w.includes('no source Word can cite'))).toBe(true);
  });

  it('names a citation of a source the document does not define', async () => {
    const env = newDocument();
    bodyOf(env).content = [citationPara([{ source: 'ghost' }], '(?)')];
    const out = await writeDocx(env, new AssetStore());
    const body = xml(partsOf(out.bytes).get('word/document.xml')!);
    expect(instructions(body)).toEqual([' CITATION ghost \\l 1033 ']);
    expect(out.warnings.some((w) => w.includes('does not define'))).toBe(true);
  });
});

describe('EXP-122 criterion 1: sources become the bibliography sources part', () => {
  it('writes each source as a b:Source in one custom XML item, referenced from the document', async () => {
    const env = newDocument();
    defsOf(env).content!.push(smith, jones);
    bodyOf(env).content = [citationPara([{ source: 'smith2020' }], '(Smith, 2020)')];
    const out = await writeDocx(env, new AssetStore());
    const parts = partsOf(out.bytes);

    const sourcesItem = [...parts.keys()].find(
      (n) => /^customXml\/item\d+\.xml$/.test(n) && parts.get(n)!.includes('b:Sources'),
    );
    expect(sourcesItem).toBeDefined();
    const root = xml(parts.get(sourcesItem!)!);
    expect(root.local).toBe('Sources');
    expect(root.ns).toBe('http://schemas.openxmlformats.org/officeDocument/2006/bibliography');

    const sources = all(root, 'Source');
    expect(sources.length).toBe(2);
    const tagOf = (s: XmlElement): string => rawText(all(s, 'Tag')[0]!);
    expect(sources.map(tagOf)).toEqual(['smith2020', 'jones2021']);

    const smithSrc = sources[0]!;
    expect(rawText(all(smithSrc, 'SourceType')[0]!)).toBe('Book');
    expect(rawText(all(smithSrc, 'Title')[0]!)).toBe('A Book of Things');
    expect(rawText(all(smithSrc, 'Year')[0]!)).toBe('2020');
    expect(rawText(all(smithSrc, 'Last')[0]!)).toBe('Smith');
    expect(rawText(all(smithSrc, 'First')[0]!)).toBe('Ada');
    expect(rawText(all(smithSrc, 'City')[0]!)).toBe('Leeds');

    const jonesSrc = sources[1]!;
    expect(rawText(all(jonesSrc, 'SourceType')[0]!)).toBe('JournalArticle');
    expect(rawText(all(jonesSrc, 'JournalName')[0]!)).toBe('Journal of Tests');
    expect(rawText(all(jonesSrc, 'Pages')[0]!)).toBe('10-20');
    expect(rawText(all(jonesSrc, 'Corporate')[0]!)).toBe('The Working Group');

    // The item's datastore names the bibliography schema, and the document refers to the item.
    const n = sourcesItem!.match(/item(\d+)\.xml$/)![1];
    expect(parts.get(`customXml/itemProps${n}.xml`)).toContain(
      'http://schemas.openxmlformats.org/officeDocument/2006/bibliography',
    );
    const docRels = parts.get('word/_rels/document.xml.rels')!;
    expect(docRels).toContain(`Target="../customXml/item${n}.xml"`);
  });

  it('writes no sources part for a document with no sources', async () => {
    const env = newDocument();
    bodyOf(env).content = [citationPara([{ source: 'smith2020' }], '(?)')];
    const out = await writeDocx(env, new AssetStore());
    const parts = partsOf(out.bytes);
    expect([...parts.values()].some((p) => p.includes('b:Sources'))).toBe(false);
  });

  it('gives the sources of an uncited document too, so that Word keeps the list', async () => {
    const env = newDocument();
    defsOf(env).content!.push(smith);
    bodyOf(env).content = [
      { type: 'paragraph', attrs: { id: nid('p') }, content: [t('No cites.')] },
    ];
    const out = await writeDocx(env, new AssetStore());
    const parts = partsOf(out.bytes);
    expect([...parts.values()].some((p) => p.includes('<b:Tag>smith2020</b:Tag>'))).toBe(true);
  });
});
