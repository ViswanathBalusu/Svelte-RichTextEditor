/**
 * The preflight shared by the editor and the converter (09 §1; EXP-003, EXP-113): warnings, before
 * anything is typeset, about content that will not typeset well. One implementation, universal,
 * so the editor and the export job report the same occurrences with the same codes; the converter
 * runs it and puts its warnings into the job's diagnostics.
 *
 * - `table_cannot_span_pages`: a table in a multi-column section or in a header or footer, which
 *   the boxed writer sets and which cannot break across pages (09 §3.2).
 * - `glyph_missing`: a character that neither the run's face nor the fallback chain covers (09
 *   §3.2), when the font manifest gives coverage.
 * - `image_without_alt`: a picture without alternative text (09 §13).
 *
 * - `row_taller_than_page` and `block_taller_than_page` (EXP-039): a table row taller than a page,
 *   and a block in it that is taller than a page and cannot be split. They need the heights of the
 *   editor's own page layout, with no first compile pass (owner decision 114), given as `measure`
 *   (`table-measure.ts`); without it nothing is reported. The editor and the converter both pass
 *   the measure and get the same result from this function.
 *
 * The editor calls it through `@docedit/export-latex/preflight`, which brings in this file, the
 * coverage reader and `@docedit/model` only (`packages/element/src/export-preflight.ts`).
 */
import {
  resolveParagraph,
  resolveRun,
  styleTable,
  type CdmEnvelope,
  type TreeNode,
} from '@docedit/model';
import type { FontFace, FontManifest } from './bundle.ts';
import { covers, mergeRanges, type CodeRange } from './fonts/coverage.ts';
import { planRowSplit, type TableMeasure } from './table-measure.ts';

export interface PreflightWarning {
  readonly code:
    | 'table_cannot_span_pages'
    | 'glyph_missing'
    | 'image_without_alt'
    | 'row_taller_than_page'
    | 'block_taller_than_page';
  /** The block the occurrence is in: the table, the paragraph, the figure or the footnote's paragraph. */
  readonly blockId: string | null;
  readonly message: string;
  /** For `glyph_missing`: the code point. */
  readonly codePoint?: number;
}

interface N {
  type: string;
  attrs?: Record<string, unknown>;
  content?: N[];
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  text?: string;
}

const IGNORED = new Set([0x20, 0xa0, 0xad]);

function idOf(n: N | undefined): string | null {
  const id = n?.attrs?.['id'];
  return typeof id === 'string' ? id : null;
}

export function preflight(
  envelope: CdmEnvelope,
  fonts?: FontManifest,
  measure?: TableMeasure,
): PreflightWarning[] {
  const doc = envelope.doc as unknown as N;
  const table = styleTable(doc as unknown as TreeNode);
  const out: PreflightWarning[] = [];
  const defs = (doc.content ?? []).find((c) => c.type === 'defs');
  const columnsOf = new Map<string, number>();
  for (const d of defs?.content ?? [])
    if (d.type === 'page_setup' && typeof d.attrs?.['id'] === 'string')
      columnsOf.set(d.attrs['id'], typeof d.attrs['columns'] === 'number' ? d.attrs['columns'] : 1);

  // Fonts: the faces of each family, and the fallback chain, with coverage when given.
  const families = new Map<
    string,
    Record<'regular' | 'bold' | 'italic' | 'boldItalic', FontFace>
  >();
  for (const f of fonts?.families ?? []) families.set(f.name, f);
  const defaultFamily = fonts?.defaultFamily ?? null;
  const chain = fonts ? (fonts.fallback ?? [fonts.math]) : [];
  const fallback: CodeRange[][] | null = chain.every((f) => f.coverage)
    ? chain.map((f) => f.coverage!)
    : null;
  const reported = new Set<string>();

  const glyphs = (
    value: string,
    family: string | null,
    bold: boolean,
    italic: boolean,
    blockId: string | null,
  ): void => {
    if (!fonts || !fallback) return;
    const fam = families.get(family ?? defaultFamily ?? '') ?? families.get(defaultFamily ?? '');
    if (!fam) return;
    const face = bold ? (italic ? fam.boldItalic : fam.bold) : italic ? fam.italic : fam.regular;
    if (!face.coverage) return;
    for (const ch of value.normalize('NFC')) {
      const cp = ch.codePointAt(0)!;
      if (cp < 0x20 || IGNORED.has(cp)) continue;
      if (covers(face.coverage, cp) || fallback.some((r) => covers(r, cp))) continue;
      const key = `${blockId ?? ''}:${cp}`;
      if (reported.has(key)) continue;
      reported.add(key);
      out.push({
        code: 'glyph_missing',
        blockId,
        codePoint: cp,
        message: `no font of the manifest has U+${cp.toString(16).toUpperCase().padStart(4, '0')}`,
      });
    }
  };

  const inlines = (
    nodes: readonly N[] | undefined,
    attrs: Record<string, unknown> | undefined,
    tableStyle: string | null,
    blockId: string | null,
  ): void => {
    const r = resolveParagraph(table, attrs, { tableStyle });
    for (const n of nodes ?? []) {
      if (n.type === 'text' && r.ok) {
        const run = resolveRun(table, r.value, n.marks as never);
        if (run.ok && !run.value.hidden)
          glyphs(n.text ?? '', run.value.fontFamily, run.value.bold, run.value.italic, blockId);
      } else if (n.type === 'image') {
        const alt = n.attrs?.['alt'];
        if (typeof alt !== 'string' || alt.trim() === '')
          out.push({
            code: 'image_without_alt',
            blockId,
            message: 'an image has no alternative text (09 §13)',
          });
      } else if (n.type === 'footnote') {
        for (const p of n.content ?? []) {
          if (p.type === 'paragraph') {
            const pa = { ...(p.attrs ?? {}) };
            if (
              (pa['style'] === undefined || pa['style'] === null) &&
              table.styles.has('FootnoteText')
            )
              pa['style'] = 'FootnoteText';
            inlines(p.content, pa, null, idOf(p) ?? idOf(n));
          }
        }
      }
    }
  };

  const blocks = (
    nodes: readonly N[] | undefined,
    columns: () => number,
    place: 'body' | 'cell' | 'story',
    tableStyle: string | null,
  ): void => {
    for (const b of nodes ?? []) {
      switch (b.type) {
        case 'paragraph':
          inlines(b.content, b.attrs, tableStyle, idOf(b));
          break;
        case 'region':
          blocks(b.content, columns, place, tableStyle);
          break;
        case 'table': {
          if (place === 'story' || columns() > 1)
            out.push({
              code: 'table_cannot_span_pages',
              blockId: idOf(b),
              message:
                'a table in a multi-column section, a header or a footer is set as a box and cannot span pages (09 §3.2)',
            });
          const style = typeof b.attrs?.['style'] === 'string' ? b.attrs['style'] : null;
          // A row taller than a page (EXP-039 criterion 4), from the editor's own layout (owner
          // decision 114). Only a table that can span pages is split; the shared plan is the
          // converter's, so both name the same row and the same blocks.
          if (measure && place !== 'story' && columns() === 1) {
            const headerRows = Number(b.attrs?.['headerRows'] ?? 0) || 0;
            (b.content ?? []).forEach((row, r) => {
              if (r < headerRows) return;
              const cells = (row.content ?? []).map((c) => ({
                cellId: idOf(c),
                blocks: c.content ?? [],
              }));
              const plan = planRowSplit(measure, idOf(b), idOf(row), cells, idOf);
              if (!plan) return;
              out.push({
                code: 'row_taller_than_page',
                blockId: idOf(b),
                message: `row ${r + 1} of table ${idOf(b) ?? '(no id)'} is taller than a page and will be split at paragraph boundaries (09 §3.2)`,
              });
              for (const u of plan.unsplittable) {
                const blockId = idOf(cells[u.cell]?.blocks[u.index]);
                out.push({
                  code: 'block_taller_than_page',
                  blockId,
                  message: `block ${blockId ?? '(no id)'} in row ${r + 1} of table ${idOf(b) ?? '(no id)'} is taller than a page and cannot be split (09 §3.2)`,
                });
              }
            });
          }
          for (const row of b.content ?? [])
            for (const cell of row.content ?? []) blocks(cell.content, columns, 'cell', style);
          break;
        }
        case 'figure': {
          const alt = b.attrs?.['alt'];
          if (typeof alt !== 'string' || alt.trim() === '')
            out.push({
              code: 'image_without_alt',
              blockId: idOf(b),
              message: 'a figure has no alternative text (09 §13)',
            });
          for (const c of b.content ?? [])
            if (c.type === 'caption')
              inlines(
                c.content,
                { style: table.styles.has('Caption') ? 'Caption' : null },
                null,
                idOf(b),
              );
          break;
        }
        default:
          break;
      }
    }
  };

  const body = (doc.content ?? []).find((c) => c.type === 'body');
  let cols = columnsOf.get(String(body?.attrs?.['pageSetup'] ?? '')) ?? 1;
  for (const b of body?.content ?? []) {
    if (b.type === 'section_break')
      cols = columnsOf.get(String(b.attrs?.['pageSetup'] ?? '')) ?? cols;
    else blocks([b], () => cols, 'body', null);
  }
  for (const s of doc.content ?? [])
    if (s.type === 'story') blocks(s.content, () => 1, 'story', null);
  return out;
}

/** Coverage of a whole family, for callers that want to show it (the editor's font panel). */
export function familyCoverage(faces: readonly FontFace[]): CodeRange[] | null {
  return faces.every((f) => f.coverage) ? mergeRanges(faces.flatMap((f) => f.coverage!)) : null;
}
