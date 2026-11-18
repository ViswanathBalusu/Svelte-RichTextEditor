/**
 * EXP-089 criterion 4 (lane w2): the DOCX writer carries the document's classification label in the
 * header and in the footer of every page (owner decision 51), as docs/adr/0414-w2-EXP-089-
 * classification-other-targets.md states. A document with section variants (a first page and even
 * pages) has the label in every header and footer part and once in each; a document with no header
 * or footer gets a default pair; a document without a label has no marking; the caller's document
 * is not changed.
 */
import { newDocument } from '@docedit/model';
import { describe, expect, it } from 'vitest';
import {
  AssetStore,
  danglingTargets,
  entryData,
  parseXml,
  readZip,
  type XmlElement,
} from '../src/index.ts';
import { writeDocx } from '../src/writer.ts';
import { writerDocs } from './writer-docs.ts';

const docs = await writerDocs();
const OPTIONS = {
  instant: '2026-11-06T23:30:00.000Z',
  timeZone: 'Europe/London',
  title: 'Title',
};
const LABEL = 'Internal & restricted 50%';

const all = (root: XmlElement, local: string): XmlElement[] => {
  const out: XmlElement[] = [];
  const stack = [root];
  while (stack.length) {
    const e = stack.pop()!;
    if (e.local === local) out.push(e);
    for (const c of e.children) if (c.kind === 'element') stack.push(c);
  }
  return out;
};

/** The XML parts of a package by name, and whether its relationships all resolve. */
function parts(bytes: Uint8Array): { parts: Map<string, string>; dangling: string[] } {
  const zip = readZip(bytes);
  const out = new Map<string, string>();
  for (const e of zip.entries)
    if (/\.xml$/.test(e.name)) out.set(e.name, new TextDecoder().decode(entryData(zip, e)));
  return { parts: out, dangling: danglingTargets(zip).map(String) };
}

/** The text of a part's `w:t` elements joined, one string per paragraph. */
function paragraphTexts(xml: string): string[] {
  const root = parseXml(new TextEncoder().encode(xml)).root;
  return all(root, 'p').map((p) =>
    all(p, 't')
      .map((t) => t.children.map((c) => (c.kind === 'text' ? c.value : '')).join(''))
      .join(''),
  );
}

const storyParts = (m: Map<string, string>): string[] =>
  [...m.keys()].filter((n) => /^word\/(header|footer)\d+\.xml$/.test(n)).sort();

describe('EXP-089 criterion 4: the DOCX writer carries the label', () => {
  it('puts the label once in every header and footer part of a document with section variants', async () => {
    const d = docs.find((x) => x.name === 'sections-notes-fields')!;
    const before = JSON.stringify(d.envelope);
    const out = await writeDocx(d.envelope, d.assets, { ...OPTIONS, classification: LABEL });
    const { parts: p, dangling } = parts(out.bytes);
    expect(dangling).toEqual([]);
    const stories = storyParts(p);
    expect(stories.length).toBeGreaterThanOrEqual(4);
    for (const name of stories) {
      const marks = paragraphTexts(p.get(name)!).filter((t) => t === LABEL);
      expect(marks, name).toHaveLength(1);
    }
    // The caller's document is not changed by the marking.
    expect(JSON.stringify(d.envelope)).toBe(before);
  });

  it('gives a document without a header or footer a default pair, referenced by its section', async () => {
    const env = newDocument();
    const out = await writeDocx(env, new AssetStore(), {
      ...OPTIONS,
      classification: LABEL,
    });
    const { parts: p, dangling } = parts(out.bytes);
    expect(dangling).toEqual([]);
    const stories = storyParts(p);
    expect(stories.some((n) => n.includes('header'))).toBe(true);
    expect(stories.some((n) => n.includes('footer'))).toBe(true);
    for (const name of stories)
      expect(paragraphTexts(p.get(name)!).filter((t) => t === LABEL)).toHaveLength(1);
    const body = parseXml(new TextEncoder().encode(p.get('word/document.xml')!)).root;
    const sect = all(body, 'sectPr')[0]!;
    expect(
      all(sect, 'headerReference').map((r) => r.attrs.find((a) => a.local === 'type')?.value),
    ).toEqual(['default']);
    expect(
      all(sect, 'footerReference').map((r) => r.attrs.find((a) => a.local === 'type')?.value),
    ).toEqual(['default']);
  });

  it('writes no marking for a document without a label, or with a blank one', async () => {
    const d = docs.find((x) => x.name === 'sections-notes-fields')!;
    for (const classification of [undefined, null, '', '  ']) {
      const out = await writeDocx(d.envelope, d.assets, {
        ...OPTIONS,
        ...(classification === undefined ? {} : { classification }),
      });
      const { parts: p } = parts(out.bytes);
      for (const name of storyParts(p))
        expect(paragraphTexts(p.get(name)!).filter((t) => t.includes('restricted'))).toEqual([]);
    }
    const plain = await writeDocx(newDocument(), docs[0]!.assets, OPTIONS);
    expect(storyParts(parts(plain.bytes).parts)).toEqual([]);
  });
});
