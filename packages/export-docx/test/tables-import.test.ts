/**
 * EXP-101, criterion 1 over the corpus: a body table of a Word file becomes a `table` node whose
 * grid, cell spans, header rows and cell shading equal those of the source. Each table node is
 * matched to its element by the source map's location, and every value is read again from the
 * element here, not from the importer's own helpers.
 *
 * Not covered here: table and cell borders, which `exp-101.test.ts` tests (the `borders` attribute
 * read by the border lenses of props.ts); nested tables and floating objects are reported (see the
 * story's Notes); pictures go through the asset worker (BE-045).
 */
import { describe, expect, it } from 'vitest';
import type { JsonNode } from '@docedit/model';
import {
  NS,
  entryData,
  importDocx,
  parseXml,
  readZip,
  type XmlDocument,
  type XmlElement,
} from '../src/index.ts';
import { corpusFiles, readFile } from './corpus.ts';

const W = NS.w;
const files = corpusFiles();

const kids = (el: XmlElement, local: string): XmlElement[] =>
  el.children.filter(
    (c): c is XmlElement => c.kind === 'element' && c.ns === W && c.local === local,
  );
const first = (el: XmlElement, local: string): XmlElement | undefined => kids(el, local)[0];
const wAttr = (el: XmlElement, local: string): string | undefined =>
  el.attrs.find((a) => a.ns === W && a.local === local)?.value;

/** The w:tbl element that starts at `start`, anywhere under `el`. */
function findTable(el: XmlElement, start: number): XmlElement | null {
  if (el.ns === W && el.local === 'tbl' && el.start === start) return el;
  for (const c of el.children) {
    if (c.kind !== 'element') continue;
    const hit = findTable(c, start);
    if (hit) return hit;
  }
  return null;
}

/** The header rows of the source: the leading rows whose w:tblHeader is the plain empty element. */
function sourceHeaderRows(tbl: XmlElement): number {
  let n = 0;
  for (const tr of kids(tbl, 'tr')) {
    const trPr = first(tr, 'trPr');
    const th = trPr && first(trPr, 'tblHeader');
    if (!th || th.attrs.length || th.children.length) break;
    n++;
  }
  return n;
}

interface Node {
  type: string;
  attrs?: Record<string, unknown>;
  content?: Node[];
}

describe.each(files)('$name', (file) => {
  it('keeps grid, spans, header rows and cell shading of each body table (criterion 1)', async () => {
    const bytes = readFile(file);
    const imported = await importDocx(bytes);
    const doc = imported.envelope.doc as JsonNode;
    const body = (doc.content ?? []).find((n) => n.type === 'body');
    const tables = ((body?.content ?? []) as Node[]).filter((n) => n.type === 'table');
    const zip = readZip(bytes);
    const parsed = new Map<string, XmlDocument>();
    const problems: string[] = [];

    for (const t of tables) {
      const id = String(t.attrs?.['id']);
      const where = imported.sourceMap.nodes[id];
      if (!where) {
        problems.push(`table ${id}: no source location`);
        continue;
      }
      let xml = parsed.get(where.part);
      if (!xml) {
        const entry = zip.byName.get(where.part);
        if (!entry) {
          problems.push(`table ${id}: part ${where.part} missing`);
          continue;
        }
        xml = parseXml(entryData(zip, entry));
        parsed.set(where.part, xml);
      }
      const tbl = findTable(xml.root, where.start);
      if (!tbl) {
        problems.push(`table ${id}: no w:tbl at ${where.start}`);
        continue;
      }

      const gridEl = first(tbl, 'tblGrid');
      const grid = gridEl ? kids(gridEl, 'gridCol').map((g) => Number(wAttr(g, 'w'))) : [];
      if (JSON.stringify(t.attrs?.['grid']) !== JSON.stringify(grid))
        problems.push(
          `table ${id}: grid ${JSON.stringify(t.attrs?.['grid'])} vs ${JSON.stringify(grid)}`,
        );

      const trs = kids(tbl, 'tr');
      const rows = t.content ?? [];
      if (rows.length !== trs.length) {
        problems.push(`table ${id}: ${rows.length} rows, ${trs.length} in the source`);
        continue;
      }
      const headerRows = sourceHeaderRows(tbl);
      if (Number(t.attrs?.['headerRows'] ?? 0) !== headerRows)
        problems.push(
          `table ${id}: headerRows ${String(t.attrs?.['headerRows'])}, expected ${headerRows}`,
        );

      rows.forEach((row, i) => {
        const tcs = kids(trs[i]!, 'tc');
        const cells = row.content ?? [];
        if (cells.length !== tcs.length) {
          problems.push(`table ${id} row ${i}: ${cells.length} cells, ${tcs.length} in the source`);
          return;
        }
        let span = 0;
        tcs.forEach((tc, j) => {
          const tcPr = first(tc, 'tcPr');
          const gs = tcPr && first(tcPr, 'gridSpan');
          const want = gs ? Number(wAttr(gs, 'val') ?? '1') : 1;
          span += want;
          const cell = cells[j]!;
          // A span of 1 is the absent default, so the cell has no colspan attribute then.
          if ((cell.attrs?.['colspan'] ?? 1) !== want)
            problems.push(
              `table ${id} row ${i} cell ${j}: colspan ${String(cell.attrs?.['colspan'])}, expected ${want}`,
            );
          const shd = tcPr && first(tcPr, 'shd');
          const fill = shd ? wAttr(shd, 'fill') : undefined;
          const shading = cell.attrs?.['shading'] as { fill?: string } | null | undefined;
          if (fill && /^[0-9A-Fa-f]{6}$/.test(fill)) {
            if (shading?.fill !== `#${fill.toUpperCase()}`)
              problems.push(
                `table ${id} row ${i} cell ${j}: shading ${JSON.stringify(shading)}, expected #${fill.toUpperCase()}`,
              );
          } else if (shading)
            problems.push(`table ${id} row ${i} cell ${j}: shading without a colour`);
        });
        if (span !== grid.length)
          problems.push(
            `table ${id} row ${i}: spans sum to ${span}, grid has ${grid.length} columns`,
          );
      });
    }
    expect(problems.slice(0, 5)).toEqual([]);
  });
});

describe('the corpus has tables with spans, header rows and shading to check', () => {
  it('holds each of the three kinds in some body table', async () => {
    let spanned = 0;
    let headed = 0;
    let shaded = 0;
    for (const f of files) {
      const imported = await importDocx(readFile(f));
      const body = ((imported.envelope.doc as JsonNode).content ?? []).find(
        (n) => n.type === 'body',
      );
      for (const t of (body?.content ?? []) as Node[]) {
        if (t.type !== 'table') continue;
        if (Number(t.attrs?.['headerRows'] ?? 0) > 0) headed++;
        for (const row of t.content ?? [])
          for (const cell of row.content ?? []) {
            if (Number(cell.attrs?.['colspan'] ?? 1) > 1) spanned++;
            if (cell.attrs?.['shading']) shaded++;
          }
      }
    }
    expect(spanned).toBeGreaterThan(0);
    expect(headed).toBeGreaterThan(0);
    expect(shaded).toBeGreaterThan(0);
  });
});
