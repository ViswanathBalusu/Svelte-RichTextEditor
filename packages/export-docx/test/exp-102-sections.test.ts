/**
 * EXP-102, criterion 1: Word sections become `page_setup` and `section_break` nodes, and headers
 * and footers become `story` nodes with first-page and even-page variants. Checked on the corpus
 * files that hold two sections (docx4j/sections_multiple.docx) and on one section with every
 * header and footer variant (poi/headerFooter.docx). The other criteria of EXP-102 are not tested
 * here: footnotes, fields, bookmarks and hyperlinks arrive as preserved atoms under ADR 0017 (A2),
 * not as the nodes and marks the story names (see the story's Notes).
 */
import { describe, expect, it } from 'vitest';
import type { JsonNode } from '@docedit/model';
import { importDocx } from '../src/index.ts';
import { corpusFiles, readFile } from './corpus.ts';

const corpus = new Map(corpusFiles().map((f) => [f.name, f]));

async function nodesOf(name: string): Promise<JsonNode[]> {
  const file = corpus.get(name);
  if (!file) throw new Error(`missing corpus file ${name}`);
  const imported = await importDocx(readFile(file));
  const out: JsonNode[] = [];
  const stack: JsonNode[] = [imported.envelope.doc as JsonNode];
  while (stack.length) {
    const n = stack.pop()!;
    out.push(n);
    for (const c of n.content ?? []) stack.push(c);
  }
  return out;
}

const attr = (n: JsonNode, key: string): unknown => n.attrs?.[key];
const idOf = (n: JsonNode): string => String(attr(n, 'id'));

/** The variant attributes of a page setup and the kind each one must have in its story node. */
const VARIANTS: ReadonlyArray<readonly [string, string]> = [
  ['headerDefault', 'header'],
  ['headerFirst', 'header'],
  ['headerEven', 'header'],
  ['footerDefault', 'footer'],
  ['footerFirst', 'footer'],
  ['footerEven', 'footer'],
];

/** Checks that every variant of a page setup names a story node of the right kind in the document. */
function expectVariantsResolve(
  pageSetup: JsonNode,
  stories: ReadonlyMap<string, JsonNode>,
  variants: ReadonlyArray<readonly [string, string]>,
): void {
  for (const [key, kind] of variants) {
    const target = attr(pageSetup, key);
    expect(typeof target, `${key} of ${idOf(pageSetup)}`).toBe('string');
    const story = stories.get(target as string);
    expect(story, `story of ${key}`).toBeDefined();
    expect(attr(story!, 'kind'), `kind of the story of ${key}`).toBe(kind);
  }
}

describe('EXP-102 criterion 1: sections, headers and footers', () => {
  it('turns two Word sections into two page setups and one section break between them', async () => {
    const nodes = await nodesOf('docx4j/sections_multiple.docx');
    const pageSetups = nodes.filter((n) => n.type === 'page_setup');
    const breaks = nodes.filter((n) => n.type === 'section_break');
    expect(pageSetups).toHaveLength(2);
    expect(breaks).toHaveLength(1);
    const target = attr(breaks[0]!, 'pageSetup');
    expect(pageSetups.map(idOf)).toContain(target);
  });

  it('gives the first section its first-page and even-page header and footer variants as story nodes', async () => {
    const nodes = await nodesOf('docx4j/sections_multiple.docx');
    const stories = new Map(
      nodes.filter((n) => n.type === 'story').map((n) => [idOf(n), n] as const),
    );
    const first = nodes.find(
      (n) => n.type === 'page_setup' && attr(n, 'differentFirstPage') === true,
    );
    expect(first).toBeDefined();
    expectVariantsResolve(first!, stories, VARIANTS);
    const ids = VARIANTS.map(([key]) => attr(first!, key));
    expect(new Set(ids).size).toBe(VARIANTS.length);
  });

  it('gives the second section its own header as a story node', async () => {
    const nodes = await nodesOf('docx4j/sections_multiple.docx');
    const stories = new Map(
      nodes.filter((n) => n.type === 'story').map((n) => [idOf(n), n] as const),
    );
    const second = nodes.find(
      (n) => n.type === 'page_setup' && attr(n, 'differentFirstPage') !== true,
    );
    expect(second).toBeDefined();
    const header = attr(second!, 'headerDefault');
    expect(typeof header).toBe('string');
    expect(attr(stories.get(header as string)!, 'kind')).toBe('header');
  });

  it('keeps every header and footer variant of a single section as a story node of the right kind', async () => {
    const nodes = await nodesOf('poi/headerFooter.docx');
    const pageSetups = nodes.filter((n) => n.type === 'page_setup');
    const stories = nodes.filter((n) => n.type === 'story');
    expect(pageSetups).toHaveLength(1);
    expect(stories.map((s) => attr(s, 'kind')).sort()).toEqual([
      'footer',
      'footer',
      'footer',
      'header',
      'header',
      'header',
    ]);
    expectVariantsResolve(
      pageSetups[0]!,
      new Map(stories.map((n) => [idOf(n), n] as const)),
      VARIANTS,
    );
  });
});
