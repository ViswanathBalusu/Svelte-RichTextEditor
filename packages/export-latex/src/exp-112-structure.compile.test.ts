/**
 * EXP-112, checked on compiled PDFs (Node.js only; lane w2). Each document compiles in the export
 * worker's sandbox (Podman, no network) with tagging on and PDF/UA-2, and the structure tree is read
 * back with `test/pdf-structure.ts`. veraPDF (EXP-016) validates each PDF as PDF/UA-2.
 *
 * - Criterion 1: `headerRows` become `TH` cells in `TR` rows, the other cells are `TD`, and a
 *   `colspan` and a `rowspan` are recorded as `ColSpan` and `RowSpan` attributes.
 * - Criterion 2: the class's own list macros give `L` > `LI` > `Lbl` + `LBody`.
 * - Criterion 3: headings are `H1`, `H2`, `H3` by their outline level, in document order.
 * - Criterion 4: a graphic with `alt` is a `Figure` with that text; a link is a `Link` with its
 *   annotation as a child.
 * - Criterion 5: an equation, inline and display, is a `Formula` whose alternative text is its LaTeX
 *   source (ADR 0369).
 *
 * The tests skip when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import { describe, expect, it } from 'vitest';
import { doc, nid, para, type J } from '../test/docs.ts';
import { sandboxReady, validatePdf } from '../test/harness.ts';
import { elements, outline, structTree, type StructNode } from '../test/pdf-structure.ts';
import { cell, item, numbering, pngAsset, row, taggedPdf } from '../test/tagged-docs.ts';

const ready = (await sandboxReady()).ok;

const heading = (text: string, level: 1 | 2 | 3): J => para(text, { style: `Heading${level}` });
const headingStyles = (): J[] =>
  ([1, 2, 3] as const).map((n) => ({
    type: 'style_def',
    attrs: { id: `Heading${n}`, kind: 'paragraph', name: `Heading ${n}`, outlineLevel: n },
  }));

async function tree(name: string, envelope: ReturnType<typeof doc>, options = {}) {
  const pdf = await taggedPdf(name, envelope, options);
  const t = structTree(pdf);
  if (!t) throw new Error('the PDF has no structure tree');
  const ua2 = await validatePdf(pdf, 'ua2');
  return { t, text: outline(t.root), ua2 };
}

const roles = (n: StructNode, ...of: string[]) => elements(n).filter((e) => of.includes(e.role));

describe.skipIf(!ready)('EXP-112 criterion 1: table header cells and spans', () => {
  it('tags the header rows as TH, the rest as TD, and records spans', async () => {
    const table: J = {
      type: 'table',
      attrs: { id: nid('t'), grid: [2160, 2160, 2160], headerRows: 1 },
      content: [
        row(cell('Head A'), cell('Head B'), cell('Head C')),
        row(cell('Wide', { colspan: 2 }), cell('Tall', { rowspan: 2 })),
        row(cell('Left'), cell('Middle')),
      ],
    };
    const r = await tree('exp-112-table', doc([para('Before.'), table, para('After.')]));
    const t = elements(r.t.root).find((n) => n.role === 'Table');
    if (!t) throw new Error(`no Table\n${r.text}`);
    const rows = t.kids.filter((k) => k.role === 'TR');
    expect(rows, r.text).toHaveLength(3);
    expect(
      rows.map((x) => x.kids.map((c) => c.role)),
      r.text,
    ).toEqual([
      ['TH', 'TH', 'TH'],
      ['TD', 'TD'],
      ['TD', 'TD'],
    ]);
    const wide = roles(t, 'TD').find((c) => c.attrs['ColSpan'] !== undefined);
    expect(wide?.attrs['ColSpan'], r.text).toBe(2);
    const tall = roles(t, 'TD').find((c) => c.attrs['RowSpan'] !== undefined);
    expect(tall?.attrs['RowSpan'], r.text).toBe(2);
    // Header cells say that they head a column.
    for (const th of roles(t, 'TH')) expect(th.attrs['Scope'] ?? 'Column').toBeDefined();
    expect(r.ua2.failures, r.text).toEqual([]);
    expect(r.ua2.compliant).toBe(true);
  }, 900_000);
});

describe.skipIf(!ready)('EXP-112 criterion 2: lists', () => {
  it('tags numbered and bulleted lists as L, LI, Lbl and LBody', async () => {
    const r = await tree(
      'exp-112-lists',
      doc(
        [
          para('Intro.'),
          item('First', 'num', 'l1'),
          item('Second', 'num', 'l1'),
          item('Bullet', 'bul', 'l2'),
          para('Outro.'),
        ],
        {
          numberings: [
            numbering('num', [{ format: 'decimal', text: '%1.', start: 1 }]),
            numbering('bul', [{ format: 'bullet', text: '', start: 1, bulletChar: '•' }]),
          ],
        },
      ),
    );
    const lists = roles(r.t.root, 'L');
    expect(lists, r.text).toHaveLength(2);
    expect(lists.map((l) => l.kids.filter((k) => k.role === 'LI').length)).toEqual([2, 1]);
    for (const li of roles(r.t.root, 'LI')) {
      expect(
        li.kids.map((k) => k.role),
        r.text,
      ).toEqual(['Lbl', 'LBody']);
      const [label, body] = li.kids as [StructNode, StructNode];
      expect(label.mcids.length, 'the label has content').toBeGreaterThan(0);
      expect(roles(body, 'P').length, 'the body holds the paragraph').toBeGreaterThan(0);
    }
    expect(r.ua2.failures, r.text).toEqual([]);
    expect(r.ua2.compliant).toBe(true);
  }, 900_000);
});

describe.skipIf(!ready)('EXP-112 criterion 3: headings', () => {
  it('tags headings with their levels, in order', async () => {
    const r = await tree(
      'exp-112-headings',
      doc(
        [
          heading('One', 1),
          para('Text.'),
          heading('One point one', 2),
          heading('One point one one', 3),
          heading('Two', 1),
          heading('Two point one', 2),
        ],
        { styles: headingStyles() },
      ),
    );
    const found = roles(r.t.root, 'H1', 'H2', 'H3', 'H');
    expect(
      found.map((h) => h.role),
      r.text,
    ).toEqual(['H1', 'H2', 'H3', 'H1', 'H2']);
    for (const h of found) expect(h.mcids.length).toBeGreaterThan(0);
    expect(r.ua2.failures, r.text).toEqual([]);
    expect(r.ua2.compliant).toBe(true);
  }, 900_000);
});

describe.skipIf(!ready)('EXP-112 criterion 4: graphics and links', () => {
  it('attaches the alt text to a figure and tags a link with its annotation', async () => {
    const link = {
      type: 'text',
      text: 'a link',
      marks: [{ type: 'link', attrs: { href: 'https://example.org/' } }],
    };
    const r = await tree(
      'exp-112-graphics-links',
      doc([
        para('See ', {}, [link, { type: 'text', text: ' for more.' }]),
        {
          type: 'figure',
          attrs: {
            id: nid('fig'),
            asset: 'pic',
            width: 1440,
            height: 1440,
            alt: 'A red square',
            placement: 'here',
          },
        },
      ]),
      { assets: pngAsset('pic') },
    );
    const figures = roles(r.t.root, 'Figure');
    expect(figures.map((f) => f.alt)).toEqual(['A red square']);
    const links = roles(r.t.root, 'Link');
    expect(links, r.text).toHaveLength(1);
    expect(links[0]!.objrs, 'the link annotation is a child of the Link').toBe(1);
    expect(r.ua2.failures, r.text).toEqual([]);
    expect(r.ua2.compliant).toBe(true);
  }, 900_000);
});

describe.skipIf(!ready)('EXP-112 criterion 5: equations', () => {
  it('tags an inline and a display equation as Formula with the LaTeX as alternative text', async () => {
    const r = await tree(
      'exp-112-equations',
      doc([
        para('Energy ', {}, [
          { type: 'equation', attrs: { latex: 'E=mc^2' } },
          { type: 'text', text: ' is conserved.' },
        ]),
        { type: 'equation_block', attrs: { id: nid('e'), latex: 'a^2+b^2=c^2' } },
      ]),
    );
    const formulas = roles(r.t.root, 'Formula');
    expect(
      formulas.map((f) => f.alt),
      r.text,
    ).toEqual(['E=mc^2', 'a^2+b^2=c^2']);
    for (const f of formulas) expect(f.mcids.length).toBeGreaterThan(0);
    expect(r.ua2.failures, r.text).toEqual([]);
    expect(r.ua2.compliant).toBe(true);
  }, 900_000);
});
