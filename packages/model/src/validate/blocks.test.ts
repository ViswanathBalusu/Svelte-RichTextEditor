// Blocks (03 §4.3, §4.5): formatting properties (CDM-025), lists (CDM-026), tables (CDM-027,
// CDM-028), images and figures (CDM-029), equations (CDM-030), tables of contents (CDM-031) and
// extension blocks (CDM-032).
import { describe, expect, it, vi } from 'vitest';
import {
  ASSET,
  addDefs,
  bodyOf,
  cell,
  codes,
  ctx,
  defsOf,
  exampleDoc,
  footnote,
  invariants,
  para,
  row,
  style,
  table,
  text,
  type Json,
} from '../../test/support.ts';
import { canonicalEnvelope, type JsonEnvelope } from '../canonical/canonical-form.ts';
import { CDM1 } from '../definition/cdm1.ts';
import { listInstances } from '../structure/lists.ts';
import { validate } from './validate.ts';

const RUN = [
  'fontFamily',
  'fontSize',
  'bold',
  'italic',
  'underline',
  'strike',
  'smallCaps',
  'allCaps',
  'vertAlign',
  'color',
  'highlight',
  'lang',
  'hidden',
];
const PARAGRAPH = [
  'align',
  'dir',
  'indentLeft',
  'indentRight',
  'indentFirstLine',
  'spaceBefore',
  'spaceAfter',
  'contextualSpacing',
  'lineSpacing',
  'lineRule',
  'keepNext',
  'keepLines',
  'pageBreakBefore',
  'widowControl',
  'tabs',
  'borders',
  'shading',
];
const node = (name: string) => CDM1.nodes.find((n) => n.name === name)!;

describe('formatting properties (CDM-025)', () => {
  it('makes every run and paragraph property its own attribute of styles, and paragraph ones of paragraphs', () => {
    for (const p of [...RUN, ...PARAGRAPH]) expect(node('style_def').attrs, p).toHaveProperty(p);
    for (const p of PARAGRAPH) expect(node('paragraph').attrs, p).toHaveProperty(p);
    for (const p of RUN) expect(node('paragraph').attrs, p).not.toHaveProperty(p);
  });

  it('stores lengths, sizes and spacing as integer twips and refuses fractions (I11)', () => {
    const ok = exampleDoc();
    Object.assign(defsOf(ok)[1]!.attrs, {
      fontSize: 210,
      spaceBefore: 240,
      indentLeft: 720,
      indentFirstLine: -360,
    });
    expect(invariants(ok)).toEqual([]);
    for (const [name, bad] of [
      ['fontSize', 10.5],
      ['spaceBefore', 240.5],
      ['indentLeft', '720'],
      ['fontSize', 10],
    ] as const) {
      const d = exampleDoc();
      defsOf(d)[1]!.attrs[name] = bad;
      expect(invariants(d), `${name} ${bad}`).toContain('I11');
    }
  });

  it('reads lineSpacing as thousandths under multiple and as a length otherwise, and lineRule has three values', () => {
    for (const [lineRule, lineSpacing] of [
      ['multiple', 1150],
      ['exact', 240],
      ['atLeast', 280],
    ] as const) {
      const d = exampleDoc();
      Object.assign(defsOf(d)[1]!.attrs, { lineRule, lineSpacing });
      expect(invariants(d), lineRule).toEqual([]);
    }
    const rule = exampleDoc();
    defsOf(rule)[1]!.attrs.lineRule = 'double';
    expect(codes(rule)).toEqual(['attribute_invalid']);
    const frac = exampleDoc();
    defsOf(frac)[1]!.attrs.lineSpacing = 1.15;
    expect(codes(frac)).toEqual(['attribute_invalid']);
  });

  it('stores colours as #RRGGBB only', () => {
    const ok = exampleDoc();
    defsOf(ok)[1]!.attrs.color = '#1F77B4';
    expect(invariants(ok)).toEqual([]);
    for (const bad of ['red', 'rgb(255,0,0)', '#F00', '#1f77b4', '1F77B4', '#1F77B4FF']) {
      const d = exampleDoc();
      defsOf(d)[1]!.attrs.color = bad;
      expect(codes(d), bad).toEqual(['attribute_invalid']);
    }
  });

  it('gives each tab stop a position, an alignment and a leader from the published values', () => {
    const tab = (t: Json) => {
      const d = exampleDoc();
      defsOf(d)[1]!.attrs.tabs = [t];
      return d;
    };
    for (const align of ['left', 'center', 'right', 'decimal'])
      for (const leader of ['none', 'dot', 'hyphen', 'underscore', 'middleDot', 'heavy'])
        expect(invariants(tab({ position: 720, align, leader })), `${align} ${leader}`).toEqual([]);
    for (const bad of [
      { position: 720, align: 'justify', leader: 'none' },
      { position: 720, align: 'left', leader: 'stars' },
      { position: 720, align: 'left' },
      { position: 720.5, align: 'left', leader: 'none' },
    ])
      expect(codes(tab(bad)), JSON.stringify(bad)).toEqual(['attribute_invalid']);
  });

  it('omits a null attribute from the canonical form ("not set here; inherit")', () => {
    const d = exampleDoc();
    Object.assign(bodyOf(d)[2]!.attrs, {
      align: null,
      spaceBefore: null,
      tabs: null,
      borders: null,
    });
    const c = canonicalEnvelope(d as JsonEnvelope);
    expect(c.doc.content![1]!.content![2]!.attrs).toEqual({
      id: 'pZ9y8X7w6V5u4T3s',
      style: 'Normal',
    });
  });

  it('accepts only booleans for keepNext, keepLines, pageBreakBefore, widowControl and contextualSpacing', () => {
    for (const name of [
      'keepNext',
      'keepLines',
      'pageBreakBefore',
      'widowControl',
      'contextualSpacing',
    ]) {
      for (const ok of [true, false, null]) {
        const d = exampleDoc();
        bodyOf(d)[2]!.attrs[name] = ok;
        expect(invariants(d), `${name} ${String(ok)}`).toEqual([]);
      }
      for (const bad of [1, 'true']) {
        const d = exampleDoc();
        bodyOf(d)[2]!.attrs[name] = bad;
        expect(invariants(d), `${name} ${bad}`).toContain('I11');
      }
    }
  });
});

const numDef = (id: string, levels = 2): Json => ({
  type: 'numbering_def',
  attrs: {
    id,
    levels: Array.from({ length: levels }, (_, i) => ({
      format: 'decimal',
      text: `%${i + 1}.`,
      start: 1,
    })),
  },
});
const item = (
  id: string,
  numberingId: string,
  level: number,
  listId: string,
  extra: Json = {},
): Json => para(id, `item ${id}`, { numbering: { numberingId, level, listId }, ...extra });

describe('lists (CDM-026)', () => {
  it('takes { numberingId, level, listId } or null, with a level the definition has (I4)', () => {
    const d = addDefs(exampleDoc(), numDef('numList', 2));
    bodyOf(d).push(
      item('pItem00000000001', 'numList', 0, 'lListA0000000001'),
      item('pItem00000000002', 'numList', 1, 'lListA0000000001'),
    );
    expect(invariants(d)).toEqual([]);
    const missingLevel = structuredClone(d);
    bodyOf(missingLevel)[3]!.attrs.numbering.level = 2;
    expect(codes(missingLevel)).toEqual(['numbering_level_missing']);
    const unresolved = structuredClone(d);
    bodyOf(unresolved)[3]!.attrs.numbering.numberingId = 'numNone';
    expect(codes(unresolved)).toEqual(['unresolved_reference']);
    const shape = structuredClone(d);
    bodyOf(shape)[3]!.attrs.numbering = { numberingId: 'numList', level: 0 };
    expect(codes(shape)).toEqual(['attribute_invalid']);
  });

  it('takes an integer or null as numberingRestart', () => {
    const d = addDefs(exampleDoc(), numDef('numList'));
    bodyOf(d).push(
      item('pItem00000000001', 'numList', 0, 'lListA0000000001', { numberingRestart: 3 }),
    );
    expect(invariants(d)).toEqual([]);
    bodyOf(d)[3]!.attrs.numberingRestart = 2.5;
    expect(codes(d)).toEqual(['attribute_invalid']);
  });

  it('resolves the numbering a paragraph style carries, which is how headings are numbered (I4)', () => {
    const d = addDefs(exampleDoc(), numDef('numHeadings'));
    defsOf(d)[2]!.attrs.numbering = {
      numberingId: 'numHeadings',
      level: 0,
      listId: 'lHeadings0000001',
    };
    expect(invariants(d)).toEqual([]);
    defsOf(d)[2]!.attrs.numbering.numberingId = 'numOther';
    expect(codes(d)).toEqual(['unresolved_reference']);
  });

  it('puts paragraphs of one definition with different listId values in two lists, which survive deletions', () => {
    const d = addDefs(exampleDoc(), numDef('numList'));
    bodyOf(d).push(
      item('pItem00000000001', 'numList', 0, 'lListA0000000001'),
      item('pItem00000000002', 'numList', 0, 'lListB0000000001'),
      item('pItem00000000003', 'numList', 0, 'lListA0000000001'),
    );
    const lists = listInstances(d['doc']);
    expect(lists.map((l) => [l.listId, l.items.map((i) => i.id)])).toEqual([
      ['lListA0000000001', ['pItem00000000001', 'pItem00000000003']],
      ['lListB0000000001', ['pItem00000000002']],
    ]);
    // Deleting the first paragraph of list A leaves the rest of list A together.
    bodyOf(d).splice(3, 1);
    expect(validate(d, ctx).valid).toBe(true);
    expect(
      listInstances(d['doc'])
        .find((l) => l.listId === 'lListA0000000001')!
        .items.map((i) => i.id),
    ).toEqual(['pItem00000000003']);
  });

  it('has no list container node: lists are paragraphs with numbering', () => {
    const names = CDM1.nodes.map((n) => n.name);
    for (const container of ['list', 'list_item', 'bullet_list', 'ordered_list'])
      expect(names).not.toContain(container);
  });
});

const simpleTable = (attrs: Json = {}, rows?: Json[]): Json =>
  table(
    'tTable0000000001',
    [2000, 2000],
    rows ?? [row('rRow000000000001', [cell('cCell0000000000A'), cell('cCell0000000000B')])],
    attrs,
  );

describe('tables with rows, cells and spans (CDM-027)', () => {
  it('holds rows of cells of paragraphs, figures and equations, with identifiers (I1, I2)', () => {
    const d = exampleDoc();
    bodyOf(d).push(
      simpleTable({}, [
        row('rRow000000000001', [
          cell('cCell0000000000A', [
            para('pCellA0000000001'),
            { type: 'equation_block', attrs: { id: 'eqCell0000000001', latex: 'x' } },
          ]),
          cell('cCell0000000000B', [
            {
              type: 'figure',
              attrs: { id: 'fgCell0000000001', asset: ASSET, width: 100, height: 100 },
            },
          ]),
        ]),
      ]),
    );
    expect(invariants(d)).toEqual([]);
    for (const [what, child] of [
      ['toc', { type: 'toc', attrs: { id: 'tocCell000000001' } }],
      [
        'extension block',
        {
          type: 'extension_block',
          attrs: { id: 'xCell00000000001', extension: 'com.example.x', fallbackText: 'x' },
        },
      ],
      [
        'region',
        { type: 'region', attrs: { id: 'rCellRegion00001' }, content: [para('pInRegion0000001')] },
      ],
      [
        'section break',
        { type: 'section_break', attrs: { id: 'sbCell0000000001', pageSetup: 'ps1' } },
      ],
    ] as const) {
      const t = exampleDoc();
      t['requires'] = ['extensions'];
      bodyOf(t).push(
        simpleTable({}, [
          row('rRow000000000001', [
            cell('cCell0000000000A', [child as Json]),
            cell('cCell0000000000B'),
          ]),
        ]),
      );
      expect(invariants(t), what).toContain('I1');
    }
    const dup = exampleDoc();
    bodyOf(dup).push(
      simpleTable({}, [
        row('rRow000000000001', [cell('cCell0000000000A'), cell('cCell0000000000A')]),
      ]),
    );
    expect(codes(dup)).toContain('duplicate_id');
  });

  it('takes positive integers as colspan and rowspan', () => {
    for (const [name, bad] of [
      ['colspan', 0],
      ['rowspan', -1],
      ['colspan', 1.5],
    ] as const) {
      const d = exampleDoc();
      bodyOf(d).push(
        simpleTable({}, [
          row('rRow000000000001', [
            cell('cCell0000000000A', undefined, { [name]: bad }),
            cell('cCell0000000000B'),
          ]),
        ]),
      );
      expect(invariants(d), `${name} ${bad}`).toContain('I11');
    }
  });

  it('checks that spans cover the grid and row spans stay inside the table (I6)', () => {
    const covered = exampleDoc();
    bodyOf(covered).push(
      simpleTable({}, [
        row('rRow000000000001', [
          cell('cCell0000000000A', undefined, { rowspan: 2 }),
          cell('cCell0000000000B'),
        ]),
        row('rRow000000000002', [cell('cCell0000000000C')]),
      ]),
    );
    expect(invariants(covered)).toEqual([]);
    const short = exampleDoc();
    bodyOf(short).push(simpleTable({}, [row('rRow000000000001', [cell('cCell0000000000A')])]));
    expect(codes(short)).toEqual(['row_columns']);
    const past = exampleDoc();
    bodyOf(past).push(
      simpleTable({}, [
        row('rRow000000000001', [
          cell('cCell0000000000A', undefined, { rowspan: 2 }),
          cell('cCell0000000000B'),
        ]),
      ]),
    );
    expect(codes(past)).toContain('row_span_past_end');
  });

  it('passes a grid of 63 columns and reports 64 as I7', () => {
    const wide = (n: number): Json => {
      const d = exampleDoc();
      bodyOf(d).push(
        table(
          'tTable0000000001',
          Array.from({ length: n }, () => 100),
          [
            row('rRow000000000001', [
              cell('cCell0000000000A', undefined, { colspan: Math.min(n, 63) }),
            ]),
          ],
        ),
      );
      return d;
    };
    expect(invariants(wide(63))).toEqual([]);
    expect(codes(wide(64))).toContain('limit_exceeded');
    expect(invariants(wide(64))).toContain('I7');
  });

  it('refuses a table in a cell, and reports one in a story or a footnote as I10', () => {
    const nested = exampleDoc();
    bodyOf(nested).push(
      simpleTable({}, [
        row('rRow000000000001', [
          cell('cCell0000000000A', [simpleTable()]),
          cell('cCell0000000000B'),
        ]),
      ]),
    );
    expect(invariants(nested)).toContain('I1');
    const inNote = exampleDoc();
    bodyOf(inNote)[2]!.content = [
      text('x'),
      footnote('fnTable000000001', [para('pFnTable00000001'), simpleTable()]),
    ];
    expect(codes(inNote)).toContain('table_in_story_or_footnote');
  });

  it('reports a floating figure or a page or column break in a cell (I10)', () => {
    const float = exampleDoc();
    bodyOf(float).push(
      simpleTable({}, [
        row('rRow000000000001', [
          cell('cCell0000000000A', [
            {
              type: 'figure',
              attrs: {
                id: 'fgFloat000000001',
                asset: ASSET,
                width: 10,
                height: 10,
                placement: 'float',
              },
            },
          ]),
          cell('cCell0000000000B'),
        ]),
      ]),
    );
    expect(codes(float)).toEqual(['float_in_cell']);
    for (const kind of ['page', 'column']) {
      const brk = exampleDoc();
      bodyOf(brk).push(
        simpleTable({}, [
          row('rRow000000000001', [
            cell('cCell0000000000A', [
              para('pBreak0000000001', [{ type: 'break', attrs: { kind } }]),
            ]),
            cell('cCell0000000000B'),
          ]),
        ]),
      );
      expect(codes(brk), kind).toEqual(['break_in_container']);
    }
  });

  it('takes headerRows from 0 to the number of rows (I6)', () => {
    const rows = [
      row('rRow000000000001', [cell('cCell0000000000A'), cell('cCell0000000000B')]),
      row('rRow000000000002', [cell('cCell0000000000C'), cell('cCell0000000000D')]),
    ];
    for (const n of [0, 1, 2]) {
      const d = exampleDoc();
      bodyOf(d).push(simpleTable({ headerRows: n }, structuredClone(rows)));
      expect(invariants(d), String(n)).toEqual([]);
    }
    const over = exampleDoc();
    bodyOf(over).push(simpleTable({ headerRows: 3 }, structuredClone(rows)));
    expect(codes(over)).toEqual(['header_rows']);
  });

  it('captions a table with an ordinary Caption paragraph holding a seq field; tables have no caption node', () => {
    expect(node('table').content).toBe('table_row+');
    const d = addDefs(exampleDoc(), style('Caption', { builtIn: true, basedOn: 'Normal' }));
    bodyOf(d).push(
      para('pCaption00000001', [
        text('Table '),
        { type: 'field', attrs: { kind: 'seq', name: 'Table' } },
      ]),
      simpleTable(),
    );
    expect(invariants(d)).toEqual([]);
    bodyOf(d)[3]!.attrs.style = 'Caption';
    expect(invariants(d)).toEqual([]);
  });
});

describe('table width, grid, borders, shading and row heights (CDM-028)', () => {
  it('needs a grid of one integer width per column', () => {
    const none = exampleDoc();
    const t = simpleTable();
    delete t.attrs.grid;
    bodyOf(none).push(t);
    expect(codes(none)).toEqual(['attribute_missing']);
    const frac = exampleDoc();
    bodyOf(frac).push(
      table(
        'tTable0000000001',
        [2000.5, 2000],
        [row('rRow000000000001', [cell('cCell0000000000A'), cell('cCell0000000000B')])],
      ),
    );
    expect(codes(frac)).toEqual(['attribute_invalid']);
  });

  it('types width as { type, value } and align by its value set', () => {
    for (const width of [
      { type: 'auto', value: 0 },
      { type: 'pct', value: 5000 },
      { type: 'fixed', value: 9000 },
    ]) {
      const d = exampleDoc();
      bodyOf(d).push(simpleTable({ width, align: 'center' }));
      expect(invariants(d), width.type).toEqual([]);
    }
    for (const attrs of [
      { width: { type: 'pct', value: 50.5 } },
      { width: { type: 'dxa', value: 100 } },
      { width: { type: 'fixed' } },
      { align: 'left' },
    ]) {
      const d = exampleDoc();
      bodyOf(d).push(simpleTable(attrs));
      expect(codes(d), JSON.stringify(attrs)).toEqual(['attribute_invalid']);
    }
  });

  it('types a row height, its rule and cantSplit', () => {
    const ok = exampleDoc();
    bodyOf(ok).push(
      simpleTable({}, [
        row('rRow000000000001', [cell('cCell0000000000A'), cell('cCell0000000000B')], {
          height: 400,
          heightRule: 'atLeast',
          cantSplit: true,
        }),
      ]),
    );
    expect(invariants(ok)).toEqual([]);
    for (const attrs of [{ height: 400.5 }, { heightRule: 'minimum' }, { cantSplit: 'yes' }]) {
      const d = exampleDoc();
      bodyOf(d).push(
        simpleTable({}, [
          row('rRow000000000001', [cell('cCell0000000000A'), cell('cCell0000000000B')], attrs),
        ]),
      );
      // A value of the wrong JSON type also fails ProseMirror's own type check (I1).
      expect(codes(d), JSON.stringify(attrs)).toContain('attribute_invalid');
    }
  });

  it('types a cell vAlign, shading, borders and margins', () => {
    const good = {
      vAlign: 'bottom',
      shading: { fill: '#D9E2F3' },
      borders: { top: { style: 'double', width: 8, color: '#000000' } },
      margins: { top: 0, bottom: 0, left: 108, right: 108 },
    };
    const ok = exampleDoc();
    bodyOf(ok).push(
      simpleTable({}, [
        row('rRow000000000001', [
          cell('cCell0000000000A', undefined, good),
          cell('cCell0000000000B'),
        ]),
      ]),
    );
    expect(invariants(ok)).toEqual([]);
    for (const attrs of [
      { vAlign: 'middle' },
      { shading: { fill: 'blue' } },
      { borders: { insideH: { style: 'single' } } },
      { borders: { top: { style: 'wavy' } } },
      { margins: { top: -1 } },
    ]) {
      const d = exampleDoc();
      bodyOf(d).push(
        simpleTable({}, [
          row('rRow000000000001', [
            cell('cCell0000000000A', undefined, attrs),
            cell('cCell0000000000B'),
          ]),
        ]),
      );
      expect(codes(d), JSON.stringify(attrs)).toEqual(['attribute_invalid']);
    }
  });

  it('reports a table style that names no table style (I4)', () => {
    const none = exampleDoc();
    bodyOf(none).push(simpleTable({ style: 'TableGrid' }));
    expect(codes(none)).toEqual(['unresolved_reference']);
    const wrong = exampleDoc();
    bodyOf(wrong).push(simpleTable({ style: 'Normal' }));
    expect(codes(wrong)).toEqual(['wrong_reference_kind']);
  });
});

describe('images and figures (CDM-029)', () => {
  const figure = (attrs: Json, content?: Json[]): Json => ({
    type: 'figure',
    attrs: { id: 'fgFigure00000001', asset: ASSET, width: 4000, height: 3000, ...attrs },
    ...(content ? { content } : {}),
  });
  const image = (attrs: Json): Json => ({
    type: 'image',
    attrs: { asset: ASSET, width: 480, height: 480, ...attrs },
  });

  it('refers to an asset by its UUID version 7 and refuses embedded data (I11)', () => {
    for (const asset of [
      'data:image/png;base64,iVBORw0KGgo=',
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
      'https://example.org/a.png',
      '0192f0c4-7b1e-4c3a-9a54-3f2f1f6f8a10',
    ]) {
      const f = exampleDoc();
      bodyOf(f).push(figure({ asset }));
      expect(codes(f), asset).toEqual(['attribute_invalid']);
      const i = exampleDoc();
      bodyOf(i)[2]!.content = [image({ asset })];
      expect(codes(i), asset).toEqual(['attribute_invalid']);
    }
  });

  it('reports an asset that is not attached to the document (I4)', () => {
    const d = exampleDoc();
    bodyOf(d).push(figure({ asset: '0192f0c4-7b1e-7c3a-9a54-0000000000ff' }));
    expect(codes(d)).toEqual(['asset_not_attached']);
  });

  it('types width, height, align and alt; alt may be empty', () => {
    const ok = exampleDoc();
    bodyOf(ok).push(figure({ align: 'center', alt: '' }));
    bodyOf(ok)[2]!.content = [image({ alt: 'Logo' })];
    expect(invariants(ok)).toEqual([]);
    for (const attrs of [
      { width: 0 },
      { height: 10.5 },
      { align: 'justify' },
      { alt: 'x'.repeat(2049) },
      { alt: 'a\u0007b' },
    ]) {
      const d = exampleDoc();
      bodyOf(d).push(figure(attrs));
      expect(codes(d), JSON.stringify(attrs).slice(0, 40)).toEqual(['attribute_invalid']);
    }
  });

  it('holds an optional caption of inline content, without footnotes or page and column breaks (I10)', () => {
    const ok = exampleDoc();
    bodyOf(ok).push(
      figure({}, [
        {
          type: 'caption',
          content: [
            text('Figure '),
            { type: 'field', attrs: { kind: 'seq', name: 'Figure' } },
            { type: 'break', attrs: { kind: 'line' } },
          ],
        },
      ]),
    );
    expect(invariants(ok)).toEqual([]);
    const note = exampleDoc();
    bodyOf(note).push(
      figure({}, [{ type: 'caption', content: [text('x'), footnote('fnCaption0000001')] }]),
    );
    expect(codes(note)).toContain('footnote_in_caption');
    const brk = exampleDoc();
    bodyOf(brk).push(
      figure({}, [
        { type: 'caption', content: [text('x'), { type: 'break', attrs: { kind: 'page' } }] },
      ]),
    );
    expect(codes(brk)).toEqual(['break_in_container']);
  });

  it('places a figure here or as a float, and nothing else', () => {
    for (const placement of ['here', 'float']) {
      const d = exampleDoc();
      bodyOf(d).push(figure({ placement }));
      expect(invariants(d), placement).toEqual([]);
    }
    const wrap = exampleDoc();
    bodyOf(wrap).push(figure({ placement: 'square' }));
    expect(codes(wrap)).toEqual(['attribute_invalid']);
  });

  it('reports a floating figure in a table cell (I10)', () => {
    const d = exampleDoc();
    bodyOf(d).push(
      simpleTable({}, [
        row('rRow000000000001', [
          cell('cCell0000000000A', [figure({ placement: 'float' })]),
          cell('cCell0000000000B'),
        ]),
      ]),
    );
    expect(codes(d)).toEqual(['float_in_cell']);
  });
});

describe('equations (CDM-030)', () => {
  const eq = (attrs: Json): Json => ({
    type: 'equation_block',
    attrs: { id: 'eqBlock000000001', latex: 'E = mc^2', ...attrs },
  });

  it('is a block atom with id, latex, numbered and label, or an inline atom with latex', () => {
    expect(Object.keys(node('equation_block').attrs)).toEqual([
      'id',
      'latex',
      'numbered',
      'label',
      'preserved',
      'ext',
    ]);
    expect(node('equation_block').atom && node('equation').atom && node('equation').inline).toBe(
      true,
    );
    expect(Object.keys(node('equation').attrs)).toEqual(['latex', 'preserved', 'origin', 'ext']);
    const d = exampleDoc();
    bodyOf(d).push(eq({ numbered: true, label: 'eq:energy' }));
    bodyOf(d)[2]!.content = [{ type: 'equation', attrs: { latex: 'x^2' } }];
    expect(invariants(d)).toEqual([]);
    const bad = exampleDoc();
    bodyOf(bad).push(eq({ numbered: 'yes' }));
    expect(codes(bad)).toContain('attribute_invalid');
  });

  it('passes latex of 4,000 characters and reports 4,001 as I7', () => {
    const at = (n: number) => {
      const d = exampleDoc();
      bodyOf(d).push(eq({ latex: 'x'.repeat(n) }));
      return d;
    };
    expect(invariants(at(4000))).toEqual([]);
    expect(codes(at(4001))).toEqual(['limit_exceeded']);
    expect(invariants(at(4001))).toEqual(['I7']);
  });

  it('calls the math gate on a latex value a commit sets or changes, and reports a refusal as I8', () => {
    const before = exampleDoc();
    bodyOf(before).push(eq({ latex: 'a+b' }));
    const after = structuredClone(before);
    bodyOf(after)[3]!.attrs.latex = '\\input{secret}';
    const gate = vi.fn((latex: string) =>
      latex.includes('\\input') ? '\\input is not allowed' : null,
    );
    const r = validate(after, { ...ctx, mathGate: gate, previous: before });
    expect(gate).toHaveBeenCalledExactlyOnceWith('\\input{secret}', true);
    expect(r.violations).toEqual([
      expect.objectContaining({
        invariant: 'I8',
        code: 'math_refused',
        message: 'math gate: \\input is not allowed',
      }),
    ]);
  });

  it('does not call the gate for a commit that touches no latex attribute', () => {
    const before = exampleDoc();
    bodyOf(before).push(eq({ latex: 'a+b' }));
    bodyOf(before)[2]!.content = [{ type: 'equation', attrs: { latex: 'x^2' } }];
    const after = structuredClone(before);
    bodyOf(after)[0]!.content[0].text = 'Scope and terms';
    const gate = vi.fn(() => null);
    expect(validate(after, { ...ctx, mathGate: gate, previous: before.doc }).valid).toBe(true);
    expect(gate).not.toHaveBeenCalled();
  });

  it('can be the target of a ref field through its label, and sits in a table cell', () => {
    const d = exampleDoc();
    bodyOf(d).push(
      simpleTable({}, [
        row('rRow000000000001', [
          cell('cCell0000000000A', [eq({ numbered: true, label: 'energy' })]),
          cell('cCell0000000000B'),
        ]),
      ]),
    );
    bodyOf(d)[2]!.content = [
      text('See '),
      { type: 'field', attrs: { kind: 'ref', target: 'eq:energy' } },
    ];
    expect(invariants(d)).toEqual([]);
    bodyOf(d)[2]!.content[1].attrs.target = 'eq:other';
    expect(codes(d)).toEqual(['field_target_unresolved']);
  });
});

describe('tables of contents (CDM-031)', () => {
  const toc = (attrs: Json): Json => ({ type: 'toc', attrs: { id: 'tocMain000000001', ...attrs } });

  it('is an atom with id, minLevel, maxLevel and of; levels 1 to 9 with minLevel at most maxLevel', () => {
    expect(Object.keys(node('toc').attrs)).toEqual([
      'id',
      'minLevel',
      'maxLevel',
      'of',
      'preserved',
      'ext',
    ]);
    for (const attrs of [
      { minLevel: 1, maxLevel: 9 },
      { minLevel: 2, maxLevel: 2 },
    ]) {
      const d = exampleDoc();
      bodyOf(d).push(toc(attrs));
      expect(invariants(d), JSON.stringify(attrs)).toEqual([]);
    }
    for (const [attrs, code] of [
      [{ minLevel: 0 }, 'attribute_invalid'],
      [{ maxLevel: 10 }, 'attribute_invalid'],
      [{ minLevel: 4, maxLevel: 2 }, 'toc_levels'],
    ] as const) {
      const d = exampleDoc();
      bodyOf(d).push(toc(attrs));
      expect(codes(d), JSON.stringify(attrs)).toEqual([code]);
    }
  });

  it('lists headings or a caption sequence', () => {
    for (const of of ['headings', 'Figure', 'Table']) {
      const d = exampleDoc();
      bodyOf(d).push(toc({ of }));
      expect(invariants(d), of).toEqual([]);
    }
    const bad = exampleDoc();
    bodyOf(bad).push(toc({ of: 'all tables!' }));
    expect(codes(bad)).toEqual(['attribute_invalid']);
  });

  it('stores no entries, so a changed heading leaves the toc node unchanged', () => {
    const d = exampleDoc();
    bodyOf(d).push(toc({ maxLevel: 2 }));
    const before = JSON.stringify(
      canonicalEnvelope(d as JsonEnvelope).doc.content![1]!.content![3],
    );
    bodyOf(d)[0]!.content[0].text = 'A new heading';
    expect(JSON.stringify(canonicalEnvelope(d as JsonEnvelope).doc.content![1]!.content![3])).toBe(
      before,
    );
    expect(node('toc').content).toBeUndefined();
  });

  it('is refused in a table cell', () => {
    const d = exampleDoc();
    bodyOf(d).push(
      simpleTable({}, [
        row('rRow000000000001', [cell('cCell0000000000A', [toc({})]), cell('cCell0000000000B')]),
      ]),
    );
    expect(invariants(d)).toContain('I1');
  });
});

describe('extension nodes (CDM-032)', () => {
  const block = (attrs: Json): Json => ({
    type: 'extension_block',
    attrs: { id: 'xBlock0000000001', extension: 'com.example.chart', ...attrs },
  });
  const inline = (attrs: Json): Json => ({
    type: 'extension_inline',
    attrs: { extension: 'com.example.badge', ...attrs },
  });
  const withExt = (f: (d: Json) => void): Json => {
    const d = exampleDoc();
    d['requires'] = ['extensions'];
    f(d);
    return d;
  };

  it('needs a fallback picture or text on a block (I12)', () => {
    expect(invariants(withExt((d) => bodyOf(d).push(block({ fallbackText: 'Chart' }))))).toEqual(
      [],
    );
    expect(invariants(withExt((d) => bodyOf(d).push(block({ fallbackAsset: ASSET }))))).toEqual([]);
    expect(codes(withExt((d) => bodyOf(d).push(block({ payload: { a: 1 } }))))).toEqual([
      'extension_fallback',
    ]);
    expect(invariants(withExt((d) => bodyOf(d).push(block({}))))).toEqual(['I12']);
  });

  it('passes a payload of 16 KiB and reports a larger one as I12', () => {
    // {"d":"…"} is 8 bytes of JSON around the string.
    const payload = (bytes: number) => ({ d: 'x'.repeat(bytes - 8) });
    expect(
      invariants(
        withExt((d) => bodyOf(d).push(block({ payload: payload(16384), fallbackText: 'x' }))),
      ),
    ).toEqual([]);
    const big = withExt((d) =>
      bodyOf(d).push(block({ payload: payload(16385), fallbackText: 'x' })),
    );
    expect(codes(big)).toEqual(['extension_envelope']);
    expect(invariants(big)).toEqual(['I12']);
  });

  it('needs a fallback text on an inline extension (I12)', () => {
    expect(
      invariants(withExt((d) => (bodyOf(d)[2]!.content = [inline({ fallbackText: 'Badge' })]))),
    ).toEqual([]);
    expect(
      codes(withExt((d) => (bodyOf(d)[2]!.content = [inline({ payload: { level: 3 } })]))),
    ).toEqual(['extension_fallback']);
  });

  it('checks the envelope as I12 and never interprets the payload', () => {
    const name = withExt((d) => bodyOf(d).push(block({ extension: 'Chart!', fallbackText: 'x' })));
    expect(codes(name)).toEqual(['extension_envelope']);
    const float = withExt((d) =>
      bodyOf(d).push(block({ payload: { ratio: 0.5 }, fallbackText: 'x' })),
    );
    expect(invariants(float)).toEqual(['I12']);
    // Any JSON within the limit passes, whatever it means to the extension.
    const opaque = withExt((d) =>
      bodyOf(d).push(
        block({
          payload: { script: '<script>alert(1)</script>', nested: [[[1]]] },
          fallbackText: 'x',
        }),
      ),
    );
    expect(invariants(opaque)).toEqual([]);
  });

  it('reports a fallback picture that is not attached (I4)', () => {
    const d = withExt((x) =>
      bodyOf(x).push(block({ fallbackAsset: '0192f0c4-7b1e-7c3a-9a54-0000000000ee' })),
    );
    expect(codes(d)).toEqual(['asset_not_attached']);
  });

  it('needs `extensions` in requires (I1)', () => {
    const d = exampleDoc();
    bodyOf(d).push(block({ fallbackText: 'x' }));
    expect(codes(d)).toEqual(['feature_missing']);
  });
});
