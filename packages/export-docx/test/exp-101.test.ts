/**
 * EXP-101, criterion 1 over the S11 corpus: a Word table becomes a table with a stored grid, spans,
 * shading, header rows and borders. Direct table borders (`w:tblBorders`) and cell borders
 * (`w:tcBorders`) become the `borders` attribute of `table` and `table_cell`; the original element
 * also stays in the preserved residue (A2), so an unedited border is written back as it was. The
 * other criteria of EXP-101 stay open (see the story's Notes).
 */
import { describe, expect, it } from 'vitest';
import { type JsonNode, utf8 } from '@docedit/model';
import { importDocx } from '../src/index.ts';
import { NS } from '../src/ooxml.ts';
import {
  type LensContext,
  TBLPR,
  TCPR,
  isRaw,
  mergeContainer,
  readContainer,
} from '../src/props.ts';
import { canonicalTree } from '../src/tree.ts';
import { canonical, elements, parseXml } from '../src/xml.ts';
import { corpusFiles, readFile } from './corpus.ts';

interface TableRef {
  table: JsonNode;
  rows: JsonNode[];
}

function tablesOf(doc: JsonNode): TableRef[] {
  const out: TableRef[] = [];
  const stack: JsonNode[] = [doc];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === 'table') out.push({ table: n, rows: n.content ?? [] });
    for (const c of n.content ?? []) stack.push(c);
  }
  return out;
}

/** The tree of a shared `preserved` reference, held in the document's `defs` (preserved_def). */
function resolvePreserved(doc: JsonNode, ref: string): string {
  const defs = (doc.content ?? []).find((n) => n.type === 'defs');
  const def = (defs?.content ?? []).find(
    (n) => n.type === 'preserved_def' && n.attrs?.['id'] === ref,
  );
  return JSON.stringify(def?.attrs?.['tree'] ?? null);
}

const cellsOf = (row: JsonNode): JsonNode[] => row.content ?? [];
const spanOf = (cell: JsonNode): number => {
  const v = cell.attrs?.['colspan'];
  return typeof v === 'number' ? v : 1;
};

describe('criterion 1: a table keeps its grid, spans, header rows, shading and borders', () => {
  it('every corpus table has a valid grid, and every row fills it exactly', async () => {
    let tables = 0;
    for (const file of corpusFiles()) {
      const { envelope } = await importDocx(readFile(file));
      for (const { table, rows } of tablesOf(envelope.doc as JsonNode)) {
        tables++;
        const grid = table.attrs?.['grid'];
        expect(Array.isArray(grid), `${file.name} grid`).toBe(true);
        const cols = grid as number[];
        expect(cols.length, `${file.name} columns`).toBeGreaterThanOrEqual(1);
        expect(cols.length, `${file.name} columns`).toBeLessThanOrEqual(63);
        for (const g of cols) expect(Number.isInteger(g) && g >= 0, file.name).toBe(true);
        // The slots of a row are its own cells and the slots that row spans from above cover.
        const carried: number[] = Array.from({ length: cols.length }, () => 0);
        for (const row of rows) {
          const covered = carried.map((n) => n > 0);
          let width = covered.filter(Boolean).length;
          for (let c = 0; c < carried.length; c++) if (carried[c]! > 0) carried[c]!--;
          let col = 0;
          for (const cell of cellsOf(row)) {
            while (col < cols.length && covered[col]) col++;
            const rowspan = Number(cell.attrs?.['rowspan'] ?? 1);
            for (let k = 0; k < spanOf(cell); k++) {
              expect(col + k, `${file.name} cell past the grid`).toBeLessThan(cols.length);
              carried[col + k] = rowspan - 1;
            }
            col += spanOf(cell);
            width += spanOf(cell);
          }
          expect(width, `${file.name} row ${String(row.attrs?.['id'])}`).toBe(cols.length);
        }
        const headerRows = table.attrs?.['headerRows'];
        if (headerRows !== undefined) {
          const h = headerRows as number;
          expect(Number.isInteger(h) && h >= 1, file.name).toBe(true);
          expect(h, file.name).toBeLessThanOrEqual(rows.length);
        }
      }
    }
    expect(tables).toBeGreaterThan(0);
  });

  it('tables.docx: header rows, a column span, cell shading and borders are all stored', async () => {
    const file = corpusFiles().find((f) => f.name === 'docx4j/tables.docx')!;
    const { envelope } = await importDocx(readFile(file));
    const doc = envelope.doc as JsonNode;
    const tables = tablesOf(doc);
    expect(tables.some((t) => (t.table.attrs?.['headerRows'] as number) >= 1)).toBe(true);
    const cells = tables.flatMap((t) => t.rows.flatMap(cellsOf));
    expect(
      cells.some((c) => spanOf(c) > 1),
      'a cell with a column span',
    ).toBe(true);
    expect(
      cells.some((c) => c.attrs?.['shading'] !== undefined),
      'a cell with shading',
    ).toBe(true);
    // Cell borders are modelled: the cells of the dotted-border table carry them.
    const bordered = cells.filter((c) => c.attrs?.['borders'] !== undefined);
    expect(bordered.length, 'cells with borders').toBeGreaterThan(0);
    // A cell absorbed by a row span stays in the source, so the borders checked are those of the
    // cells that remain in the model.
    expect(
      bordered.some(
        (c) =>
          (c.attrs?.['borders'] as { left?: { style?: string; width?: number } }).left?.style ===
            'dotted' && (c.attrs?.['borders'] as { left?: { width?: number } }).left?.width === 60,
      ),
      'a cell with dotted left border of 60',
    ).toBe(true);
    // The original element stays in the residue (inline, or a shared preserved_def) for write-back.
    const residueOf = (node: JsonNode): string => {
      const pres = node.attrs?.['preserved'] as { ref?: string } | undefined;
      return pres?.ref !== undefined
        ? resolvePreserved(doc, pres.ref)
        : JSON.stringify(pres ?? null);
    };
    expect(bordered.every((c) => residueOf(c).includes('w:tcBorders'))).toBe(true);
    // Table borders in this file come from the table style `TableGrid`, not from the table.
    expect(tables.every((t) => t.table.attrs?.['borders'] === undefined)).toBe(true);
  });

  it('direct table borders become the table `borders` attribute (cr043-tracked.docx, bug65738.docx)', async () => {
    const single = { style: 'single', width: 10, space: 0, color: '#000000' };
    const cr043 = corpusFiles().find((f) => f.name === 'docx4j/cr043-tracked.docx')!;
    const a = tablesOf((await importDocx(readFile(cr043))).envelope.doc as JsonNode);
    expect(a.map((t) => t.table.attrs?.['borders'])).toContainEqual({
      top: single,
      left: single,
      bottom: single,
      right: single,
      insideH: single,
      insideV: single,
    });
    const bug = corpusFiles().find((f) => f.name === 'poi/bug65738.docx')!;
    const b = tablesOf((await importDocx(readFile(bug))).envelope.doc as JsonNode);
    const thin = { style: 'single', width: 5, space: 0, color: '#000000' };
    expect(b.some((t) => (t.table.attrs?.['borders'] as Record<string, unknown>)?.['top'])).toBe(
      true,
    );
    expect(
      b.flatMap((t) => t.rows.flatMap(cellsOf)).map((c) => c.attrs?.['borders']),
    ).toContainEqual({ left: thin, bottom: thin, right: thin });
  });
});

describe('the border lenses keep the round trip exact and write edits', () => {
  const ctx: LensContext = {
    styleToCdm: () => null,
    styleToWord: (id) => id,
    storyForRel: () => null,
    relForStory: () => null,
  };
  const container = (xml: string) => {
    const doc = parseXml(utf8(`<w:x xmlns:w="${NS.w}">${xml}</w:x>`));
    return elements(elements(doc.root)[0]!);
  };
  const text = (items: ReturnType<typeof mergeContainer>): string =>
    items.map((m) => (isRaw(m) ? m.raw : canonicalTree(m))).join('');

  const CELL =
    '<w:tcPr><w:tcBorders><w:top w:val="triple" w:sz="4" w:space="0" w:color="auto"/>' +
    '<w:left w:val="single" w:sz="8" w:space="0" w:color="1F497D" w:themeColor="text2" w:shadow="1"/>' +
    '<w:tl2br w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tcBorders></w:tcPr>';

  it('reads the sides it models and writes an unedited element back exactly', () => {
    const kids = container(CELL);
    const read = readContainer(TCPR, kids, ctx);
    expect(read.values['borders']).toEqual({
      // `triple` is not a model style: it reads as single, and the element is kept as it was.
      top: { style: 'single', width: 10, space: 0 },
      left: { style: 'single', width: 20, space: 0, color: '#1F497D' },
    });
    expect(read.full).toBe(false);
    expect(text(mergeContainer(TCPR, read.values, read.residue, ctx, []))).toBe(
      kids.map((k) => canonical(k)).join(''),
    );
  });

  it('on an edit, rewrites only the edited side and keeps what the model does not represent', () => {
    const read = readContainer(TCPR, container(CELL), ctx);
    const borders = read.values['borders'] as Record<string, unknown>;
    const edited = text(
      mergeContainer(
        TCPR,
        {
          ...read.values,
          borders: { ...borders, left: { style: 'double', width: 15, color: '#FF0000' } },
        },
        read.residue,
        ctx,
        [],
      ),
    );
    expect(edited).toContain('w:val="triple"'); // the unedited side, as it was
    expect(edited).toContain('w:tl2br'); // a side the model does not have
    expect(edited).toContain('w:val="double"');
    expect(edited).toContain('w:color="FF0000"');
    expect(edited).toContain('w:shadow="1"'); // an unmodelled attribute of the edited side
    expect(edited).not.toContain('themeColor'); // it would override the edited colour in Word
    const removed = text(
      mergeContainer(TCPR, { ...read.values, borders: null }, read.residue, ctx, []),
    );
    expect(removed).not.toContain('w:top');
    expect(removed).not.toContain('w:left');
    expect(removed).toContain('w:tl2br');
  });

  it('writes table borders in schema order when there is no original element', () => {
    const items = mergeContainer(
      TBLPR,
      {
        borders: {
          insideV: { style: 'single', width: 5 },
          top: { style: 'thick', width: 30, space: 20, color: '#00ff00' },
        },
      },
      [],
      ctx,
      [],
    );
    expect(text(items)).toBe(
      '<w:tblBorders>' +
        '<w:top w:color="00FF00" w:space="1" w:sz="12" w:val="thick"></w:top>' +
        '<w:insideV w:color="auto" w:space="0" w:sz="2" w:val="single"></w:insideV>' +
        '</w:tblBorders>',
    );
    const back = readContainer(TBLPR, container(`<w:tblPr>${text(items)}</w:tblPr>`), ctx);
    expect(back.values['borders']).toEqual({
      top: { style: 'thick', width: 30, space: 20, color: '#00FF00' },
      insideV: { style: 'single', width: 5, space: 0 },
    });
  });
});
