/**
 * The entries of a table of contents and of a list of captions (FE-136 criterion 3): which headings
 * a level range includes, that the style chain decides what a heading is, the computed number of a
 * caption, and that a list of one sequence ignores the others. The view that draws them is checked
 * in packages/engine/src/view/fe-136-toc.universal.test.ts.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { editingSchema } from '../src/schema.ts';
import { tocContext, tocEntries, tocNodes } from '../src/toc-entries.ts';

const style = (id: string, extra: Record<string, unknown> = {}) => ({
  type: 'style_def',
  attrs: { id, kind: 'paragraph', name: id, builtIn: true, ...extra },
});

const p = (id: string, styleId: string, ...content: unknown[]) => ({
  type: 'paragraph',
  attrs: { id, style: styleId },
  content,
});
const t = (text: string) => ({ type: 'text', text });
const seq = (name: string) => ({ type: 'field', attrs: { kind: 'seq', name, cached: null } });

function docOf(body: unknown[]): PMNode {
  return editingSchema().nodeFromJSON({
    type: 'doc',
    content: [
      {
        type: 'defs',
        content: [
          { type: 'settings', attrs: { lang: 'en-GB', defaultParagraphStyle: 'Normal' } },
          style('Normal'),
          style('Heading1', { basedOn: 'Normal', outlineLevel: 1 }),
          style('Heading2', { basedOn: 'Normal', outlineLevel: 2 }),
          style('Heading4', { basedOn: 'Normal', outlineLevel: 4 }),
          // A style that is a heading only through its parent.
          style('Chapter', { basedOn: 'Heading1' }),
          { type: 'page_setup', attrs: { id: 'ps1' } },
        ],
      },
      { type: 'body', attrs: { pageSetup: 'ps1' }, content: body },
    ],
  });
}

const toc = (attrs: Record<string, unknown>) => ({
  type: 'toc',
  attrs: { id: 'tocxxxxxxxxxxxxx', minLevel: 1, maxLevel: 3, of: 'headings', ...attrs },
});

const listOf = (doc: PMNode, nth = 0): Array<[number, string]> => {
  const node = tocNodes(doc)[nth]!.node;
  return tocEntries(tocContext(doc), node).map((e) => [e.level, e.text]);
};

describe('the entries of a table of contents (FE-136 criterion 3)', () => {
  it('lists the headings from the lowest to the highest level, in document order', () => {
    const doc = docOf([
      toc({}),
      p('h1xxxxxxxxxxxxxx', 'Heading1', t('One')),
      p('bodyxxxxxxxxxxxx', 'Normal', t('Text')),
      p('h2xxxxxxxxxxxxxx', 'Heading2', t('One point one')),
      p('h4xxxxxxxxxxxxxx', 'Heading4', t('Too deep')),
      p('h1bxxxxxxxxxxxxx', 'Heading1', t('Two')),
    ]);
    expect(listOf(doc)).toEqual([
      [1, 'One'],
      [2, 'One point one'],
      [1, 'Two'],
    ]);
  });

  it('honours the level limits', () => {
    const body = [
      p('h1xxxxxxxxxxxxxx', 'Heading1', t('One')),
      p('h2xxxxxxxxxxxxxx', 'Heading2', t('Two')),
      p('h4xxxxxxxxxxxxxx', 'Heading4', t('Four')),
    ];
    expect(listOf(docOf([toc({ minLevel: 2, maxLevel: 4 }), ...body]))).toEqual([
      [2, 'Two'],
      [4, 'Four'],
    ]);
    expect(listOf(docOf([toc({ minLevel: 1, maxLevel: 1 }), ...body]))).toEqual([[1, 'One']]);
  });

  it('reads a heading through the style chain, and leaves out an empty heading', () => {
    const doc = docOf([
      toc({}),
      p('chxxxxxxxxxxxxxx', 'Chapter', t('A chapter')),
      p('emptyxxxxxxxxxxx', 'Heading1'),
    ]);
    expect(listOf(doc)).toEqual([[1, 'A chapter']]);
  });

  it('a list of one caption sequence shows the computed number and ignores the others', () => {
    const doc = docOf([
      toc({ of: 'Figure', id: 'tocfigxxxxxxxxxx' }),
      toc({ of: 'Table', id: 'toctabxxxxxxxxxx' }),
      p('c1xxxxxxxxxxxxxx', 'Normal', t('Figure '), seq('Figure'), t(': first')),
      p('t1xxxxxxxxxxxxxx', 'Normal', t('Table '), seq('Table'), t(': sizes')),
      p('c2xxxxxxxxxxxxxx', 'Normal', t('Figure '), seq('Figure'), t(': second')),
    ]);
    expect(listOf(doc, 0)).toEqual([
      [1, 'Figure 1: first'],
      [1, 'Figure 2: second'],
    ]);
    expect(listOf(doc, 1)).toEqual([[1, 'Table 1: sizes']]);
  });

  it('finds no toc node where there is none', () => {
    expect(tocNodes(docOf([p('h1xxxxxxxxxxxxxx', 'Heading1', t('One'))]))).toEqual([]);
  });
});
