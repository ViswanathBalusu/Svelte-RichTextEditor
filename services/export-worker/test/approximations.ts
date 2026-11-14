/**
 * A document whose body holds one construct for each approximation the converter reports (EXP-065
 * criterion 2): a right tab in justified text (`tab_approximate`), a continuous section break that
 * changes the margins (`continuous_break_geometry`), a row-spanned cell with content
 * (`span_taller_than_rows`) and a table in a two-column section, which is set as a box
 * (`table_cannot_span_pages`). Each construct carries a fixed block identifier, so a test can check
 * that the warning names the block it came from.
 */
import type { CdmEnvelope } from '@docedit/model';

type J = Record<string, unknown>;

/** A 16-character identifier of the URL-safe alphabet, from a readable name. */
const ident = (name: string): string => name.padEnd(16, '0').slice(0, 16);

export const APPROX = {
  tabPara: ident('tabParaApprox'),
  geomBreak: ident('geomBreakApx'),
  spanTable: ident('spanTableApx'),
  spanCell: ident('spanCellApx'),
  colsBreak: ident('colsBreakApx'),
  boxTable: ident('boxTableApx'),
} as const;

/** The code each construct must produce, with the block it names. */
export const EXPECTED: ReadonlyArray<{ code: string; blockId: string }> = [
  { code: 'tab_approximate', blockId: APPROX.tabPara },
  { code: 'continuous_break_geometry', blockId: APPROX.geomBreak },
  { code: 'span_taller_than_rows', blockId: APPROX.spanCell },
  { code: 'table_cannot_span_pages', blockId: APPROX.boxTable },
];

const para = (id: string, attrs: J, content: J[]): J => ({
  type: 'paragraph',
  attrs: { id, ...attrs },
  content,
});

const text = (t: string): J => ({ type: 'text', text: t });

const cell = (id: string, content: J[], attrs: J = {}): J => ({
  type: 'table_cell',
  attrs: { id, ...attrs },
  content,
});

const row = (id: string, cells: J[]): J => ({ type: 'table_row', attrs: { id }, content: cells });

const table = (id: string, grid: number[], rows: J[]): J => ({
  type: 'table',
  attrs: { id, grid },
  content: rows,
});

const A4 = {
  width: 11906,
  height: 16838,
  marginTop: 1440,
  marginBottom: 1440,
  marginLeft: 1440,
  marginRight: 1440,
  gutter: 0,
  headerDistance: 720,
  footerDistance: 720,
};

/** The envelope of the approximating document (cdm 1, one body, three page setups). */
export function approximatingDocument(): CdmEnvelope {
  const body: J[] = [
    // A right tab in justified text.
    para(
      APPROX.tabPara,
      { align: 'justify', tabs: [{ position: 2880, align: 'right', leader: 'none' }] },
      [text('Item'), { type: 'tab' }, text('9.99')],
    ),
    // A continuous break to a page setup with a wider left margin.
    {
      type: 'section_break',
      attrs: { id: APPROX.geomBreak, pageSetup: 'ps2', start: 'continuous' },
    },
    para(ident('paraAfterGeom'), {}, [text('The margin changed.')]),
    // A row-spanned cell with content, in a single-column section.
    table(
      APPROX.spanTable,
      [1440, 1440],
      [
        row(ident('rowSpanApx01'), [
          cell(APPROX.spanCell, [para(ident('paraSpanCell'), {}, [text('A tall cell of text.')])], {
            rowspan: 2,
          }),
          cell(ident('cellSpanAp2'), [para(ident('paraSpanTwo'), {}, [text('A.')])]),
        ]),
        row(ident('rowSpanApx02'), [
          cell(ident('cellSpanAp3'), [para(ident('paraSpanThree'), {}, [text('B.')])]),
        ]),
      ],
    ),
    // A two-column section, and a table in it.
    { type: 'section_break', attrs: { id: APPROX.colsBreak, pageSetup: 'ps3' } },
    table(
      APPROX.boxTable,
      [2880],
      [
        row(ident('rowBoxApx001'), [
          cell(ident('cellBoxApx01'), [para(ident('paraBoxCell'), {}, [text('Cell.')])]),
        ]),
      ],
    ),
  ];
  return {
    cdm: 1,
    requires: [],
    doc: {
      type: 'doc',
      content: [
        {
          type: 'defs',
          content: [
            {
              type: 'settings',
              attrs: { lang: 'en-GB', defaultTabStop: 720, defaultParagraphStyle: 'Normal' },
            },
            {
              type: 'style_def',
              attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal', builtIn: true },
            },
            { type: 'page_setup', attrs: { id: 'ps1', ...A4 } },
            { type: 'page_setup', attrs: { id: 'ps2', ...A4, marginLeft: 2880 } },
            { type: 'page_setup', attrs: { id: 'ps3', ...A4, columns: 2, columnGap: 708 } },
          ],
        },
        { type: 'body', attrs: { pageSetup: 'ps1' }, content: body },
      ],
    },
  } as unknown as CdmEnvelope;
}
