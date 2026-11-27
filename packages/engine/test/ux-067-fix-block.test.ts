/**
 * UX-067 criterion 2, the core's half (Node.js): `fixBlock` makes the repair for each kind of
 * accessibility issue (alternative text, header row, link text, heading level, colour) on the block
 * the checker named, through the scope guard. A block in a part the user may not change, a value
 * that is not allowed and a block that is not there change nothing.
 */
import type { Access } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import type { CdmEnvelope } from '../src/api.ts';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { AUTH_IDS, authoringEnvelope } from './authoring-doc.ts';
import { microtask, posOf } from './support.ts';

const EDIT = ['view', 'comment', 'suggest', 'edit'] as const;
const ASSET = '01890a5d-ac96-774b-bcce-b302099a8057';
const IDS = {
  picture: 'pPicture0000001',
  figure: 'fFigure00000001',
  table: 'tTable000000001',
  link: 'pLink0000000001',
  imageLink: 'pImageLink00001',
  h1: 'pHeadOne0000001',
  h3: 'pHeadThree00001',
  dark: 'pDark000000001',
  caption: 'fCaption0000001',
  regionPicture: 'pRegionPic00001',
} as const;

type Json = Record<string, unknown>;
const text = (value: string, marks?: Json[]): Json => ({
  type: 'text',
  text: value,
  ...(marks ? { marks } : {}),
});
const paragraph = (id: string, content: Json[], style: string | null = null): Json => ({
  type: 'paragraph',
  attrs: { id, style },
  content,
});
const link = (href: string): Json => ({ type: 'link', attrs: { href, title: null } });
const picture = (): Json => ({ type: 'image', attrs: { asset: ASSET, width: 1440, height: 720 } });

function envelope(): CdmEnvelope {
  const doc = authoringEnvelope() as unknown as { content: { type: string; content: Json[] }[] };
  const defs = doc.content.find((n) => n.type === 'defs')!;
  for (const n of [1, 2, 3])
    defs.content.splice(1 + n, 0, {
      type: 'style_def',
      attrs: {
        id: `Heading${n}`,
        kind: 'paragraph',
        name: `Heading ${n}`,
        builtIn: true,
        basedOn: 'Normal',
        outlineLevel: n,
      },
    });
  const body = doc.content.find((n) => n.type === 'body')!;
  const region = body.content.find((n) => n['type'] === 'region')!;
  (region['content'] as Json[]).push(paragraph(IDS.regionPicture, [text('x'), picture()]));
  body.content.splice(
    2,
    0,
    paragraph(IDS.picture, [text('See '), picture()]),
    {
      type: 'figure',
      attrs: { id: IDS.figure },
      content: [{ type: 'caption', content: [text('A caption')] }],
    },
    {
      type: 'table',
      attrs: { id: IDS.table, grid: [1440], headerRows: 0 },
      content: [
        {
          type: 'table_row',
          content: [
            { type: 'table_cell', content: [paragraph('pCell0000000001', [text('Cell')])] },
          ],
        },
      ],
    },
    paragraph(IDS.link, [
      text('Go '),
      text('good link', [link('https://example.com/a')]),
      text(' and '),
      text('click here', [link('https://example.com/b')]),
      text('.'),
    ]),
    paragraph(IDS.imageLink, [{ ...picture(), marks: [link('https://example.com/c')] }]),
    paragraph(IDS.h1, [text('Top')], 'Heading1'),
    paragraph(IDS.h3, [text('Deep')], 'Heading3'),
    paragraph(IDS.dark, [text('Pale text')]),
  );
  return { cdm: 1, requires: [], doc: doc as unknown as CdmEnvelope['doc'] };
}

const access = (): Access => ({
  rev: 1,
  asOfSeq: 0,
  docRole: 'editor',
  caps: [...EDIT],
  scopes: {
    doc: ['view'],
    body: [...EDIT],
    defs: ['view'],
    [`region:${AUTH_IDS.region}`]: ['view', 'comment'],
  },
  leases: {},
  fill: null,
  restrictions: [],
});

function setup() {
  const core = new DocumentCore({ doc: envelope(), access: access(), schedule: microtask });
  const doc = () => internals(core).state.doc;
  const node = (id: string) => doc().nodeAt(posOf(doc(), id))!;
  return { core, doc, node };
}

describe('fixBlock repairs each kind of issue (UX-067 criterion 2)', () => {
  it('stores alternative text on the picture of a paragraph, on a figure and on a picture inside a link', () => {
    const { core, node } = setup();
    expect(core.fixBlock(IDS.picture, { fix: 'alt-text', text: ' A chart ' })).toBe(true);
    expect(node(IDS.picture).lastChild!.attrs['alt']).toBe('A chart');
    expect(core.fixBlock(IDS.figure, { fix: 'alt-text', text: 'Plan' })).toBe(true);
    expect(node(IDS.figure).attrs['alt']).toBe('Plan');
    expect(core.fixBlock(IDS.imageLink, { fix: 'alt-text', text: 'Annual report' })).toBe(true);
    expect(node(IDS.imageLink).firstChild!.attrs['alt']).toBe('Annual report');
  });

  it('refuses blank alternative text, and a paragraph with no picture without it', () => {
    const { core, node } = setup();
    expect(core.fixBlock(IDS.picture, { fix: 'alt-text', text: '   ' })).toBe(false);
    expect(node(IDS.picture).lastChild!.attrs['alt']).toBeNull();
    expect(core.fixBlock(IDS.dark, { fix: 'alt-text', text: 'x' })).toBe(false);
  });

  it('makes the first row of a table its header row, once', () => {
    const { core, node } = setup();
    expect(core.fixBlock(IDS.table, { fix: 'table-header' })).toBe(true);
    expect(node(IDS.table).attrs['headerRows']).toBe(1);
    expect(core.fixBlock(IDS.table, { fix: 'table-header' })).toBe(false);
  });

  it('replaces the text of the link stretch with the index, and keeps its address', () => {
    const { core, node } = setup();
    expect(core.fixBlock(IDS.link, { fix: 'link-text', index: 1, text: 'Price list' })).toBe(true);
    const p = node(IDS.link);
    expect(p.textContent).toBe('Go good link and Price list.');
    const marks: [string, string | null][] = [];
    p.forEach((child) =>
      marks.push([
        child.text!,
        (child.marks.find((m) => m.type.name === 'link')?.attrs['href'] as string) ?? null,
      ]),
    );
    expect(marks.find(([t]) => t === 'Price list')![1]).toBe('https://example.com/b');
    expect(marks.find(([t]) => t === 'good link')![1]).toBe('https://example.com/a');
    expect(core.fixBlock(IDS.link, { fix: 'link-text', index: 5, text: 'x' })).toBe(false);
  });

  it('gives a link made of a picture its text as the picture alternative text', () => {
    const { core, node } = setup();
    expect(
      core.fixBlock(IDS.imageLink, { fix: 'link-text', index: 0, text: 'Annual report' }),
    ).toBe(true);
    expect(node(IDS.imageLink).firstChild!.attrs['alt']).toBe('Annual report');
  });

  it('gives a heading the style of the level asked for, when the document defines it', () => {
    const { core, node } = setup();
    expect(core.fixBlock(IDS.h3, { fix: 'heading-level', level: 2 })).toBe(true);
    expect(node(IDS.h3).attrs['style']).toBe('Heading2');
    expect(core.fixBlock(IDS.h3, { fix: 'heading-level', level: 5 })).toBe(false);
    expect(core.fixBlock(IDS.h3, { fix: 'heading-level', level: 0 })).toBe(false);
    expect(core.fixBlock(IDS.table, { fix: 'heading-level', level: 2 })).toBe(false);
  });

  it('gives the text of a paragraph, and the caption of a figure, a colour', () => {
    const { core, node } = setup();
    expect(core.fixBlock(IDS.dark, { fix: 'text-colour', colour: '#ffffff' })).toBe(true);
    expect(node(IDS.dark).firstChild!.marks.map((m) => [m.type.name, m.attrs['value']])).toEqual([
      ['color', '#FFFFFF'],
    ]);
    expect(core.fixBlock(IDS.figure, { fix: 'text-colour', colour: '#000000' })).toBe(true);
    expect(node(IDS.figure).firstChild!.firstChild!.marks[0]!.attrs['value']).toBe('#000000');
    expect(core.fixBlock(IDS.dark, { fix: 'text-colour', colour: 'red' })).toBe(false);
  });

  it('changes nothing in a region the user may not change, or for a block that is not there', () => {
    const { core, doc, node } = setup();
    const before = doc();
    expect(core.fixBlock(IDS.regionPicture, { fix: 'alt-text', text: 'x' })).toBe(false);
    expect(core.fixBlock('nope000000000000', { fix: 'table-header' })).toBe(false);
    expect(doc().eq(before)).toBe(true);
    expect(node(IDS.regionPicture).lastChild!.attrs['alt']).toBeNull();
  });

  it('changes nothing while the core is read-only', () => {
    const { core, doc } = setup();
    core.setMode('view');
    const before = doc();
    expect(core.fixBlock(IDS.table, { fix: 'table-header' })).toBe(false);
    expect(doc().eq(before)).toBe(true);
  });
});
