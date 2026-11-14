/**
 * Candidate 2 of spike S7: Eigenpal's core, `@docx-editor.dev/core` 2.35.0 (Apache-2.0 for this
 * package; evaluated from its npm tarball only, borrow list §9.1), driven from CDM flow blocks.
 *
 * Eigenpal's layout reads its own canonical OOXML tree, and its public entry points take DOCX bytes
 * (`openDocumentForExport`) or a live view of that tree. So the flow blocks are first written as a
 * WordprocessingML package (ooxml.ts), then laid out, then mapped back through the projection's
 * offset map. Measurement is injected through Eigenpal's own `TextMeasurer` interface, which this
 * adapter bridges to the project's.
 */
import { openDocumentForExport } from '@docx-editor.dev/core/export';
import type { FlowDocument } from './flow.ts';
import type { FontKey, TextMeasurer } from './measure.ts';
import { cdmOffset, projectToOoxml, type OoxmlProjection } from './ooxml.ts';
import {
  freezeTree,
  type LayoutFragment,
  type LayoutLine,
  type LayoutPage,
  type LayoutRow,
  type LayoutTree,
} from './tree.ts';

export const EIGENPAL_ENGINE = '@docx-editor.dev/core@2.35.0';

type ExportOptions = NonNullable<Parameters<typeof openDocumentForExport>[1]>;
type EigenpalMeasurer = NonNullable<ExportOptions['measurer']>;

// The parts of Eigenpal's published records this adapter reads (semantic-records in its tarball).
interface EBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
interface ELine {
  readonly range: { readonly paragraphId: string; readonly start: number; readonly end: number };
  readonly box: EBox;
}
interface EParagraph {
  readonly kind: 'paragraph';
  readonly paragraphId: string;
  readonly box: EBox;
  readonly lines: readonly ELine[];
  readonly outOfFlow?: true;
}
interface ECell {
  readonly id: string;
  readonly vMergeContinue: boolean;
  readonly blocks: readonly EBlock[];
  readonly box: EBox;
}
interface ERow {
  readonly id: string;
  readonly isHeaderRepeat: boolean;
  readonly cells: readonly ECell[];
  readonly box: EBox;
}
interface ETable {
  readonly kind: 'table';
  readonly tableId: string;
  readonly box: EBox;
  readonly rows: readonly ERow[];
}
type EBlock = EParagraph | ETable;
interface EStory {
  readonly box: EBox;
  readonly fragments: readonly EBlock[];
}
interface EPage {
  readonly index: number;
  readonly box: EBox;
  readonly contentBox: EBox;
  readonly fragments: readonly EBlock[];
  readonly header?: EStory;
  readonly footer?: EStory;
  readonly footnotes?: { readonly notes: readonly EStory[] };
}
interface ELayout {
  readonly pages: readonly EPage[];
}

/**
 * Eigenpal's `TextMeasurer`, answered by the project's. When the project's measurer has
 * `advances`, the bridge also answers Eigenpal's optional `caretAdvances` from one call per run;
 * without it Eigenpal measures prefixes one by one (see the spike report for the call counts).
 */
export function bridgeMeasurer(
  measurer: TextMeasurer,
  fallbackFamily = 'Noto Serif',
): EigenpalMeasurer {
  const key = (style: {
    fontFamily: string | null;
    fontSizePt: number;
    bold: boolean;
    italic: boolean;
  }): FontKey => ({
    family: style.fontFamily ?? fallbackFamily,
    sizePt: style.fontSizePt,
    bold: style.bold,
    italic: style.italic,
  });
  const perUnit = measurer.advances?.bind(measurer);
  return {
    measure: (text, style) => measurer.advance(key(style), text),
    ...(perUnit
      ? {
          caretAdvances: (text: string, style: Parameters<EigenpalMeasurer['measure']>[1]) => {
            const units = perUnit(key(style), text);
            const out = [0];
            let sum = 0;
            for (const a of units) out.push((sum += a));
            return out;
          },
        }
      : {}),
    lineMetrics: (style) => {
      const m = measurer.lineMetrics(key(style));
      return { height: m.ascent + m.descent + m.lineGap, baseline: m.ascent + m.lineGap / 2 };
    },
  };
}

export interface EigenpalReport {
  readonly tree: LayoutTree;
  readonly projection: { readonly bytes: number; readonly carriers: number };
  /** Paragraph identifiers the engine reported that the projection did not write. */
  readonly unknownParagraphs: readonly string[];
  /** Paragraphs whose last line does not end at the projected length (an offset-model mismatch). */
  readonly lengthMismatches: readonly string[];
}

/**
 * Coordinates: every record of a page body (fragments, lines, table rows and cells, cell content)
 * is in one space, the page's content box; header, footer and note records are relative to their
 * story's box. Found by comparing positions with the Docen adapter on the same documents.
 */
function blocksToFragments(
  p: OoxmlProjection,
  blocks: readonly EBlock[],
  x0: number,
  y0: number,
  unknown: Set<string>,
  mismatches: Set<string>,
): LayoutFragment[] {
  const out: LayoutFragment[] = [];
  for (const b of blocks) {
    if (b.kind === 'paragraph') {
      const entry = p.paragraphs.get(b.paragraphId);
      if (!entry) {
        unknown.add(b.paragraphId);
        continue;
      }
      if (entry.kind === 'carrier') continue;
      const x = x0 + b.box.x;
      const y = y0 + b.box.y;
      if (entry.kind === 'box') {
        out.push({
          kind: 'box',
          blockId: entry.blockId,
          x,
          y,
          width: b.box.width,
          height: b.box.height,
        });
        continue;
      }
      const lines: LayoutLine[] = b.lines.map((l) => ({
        from: cdmOffset(entry, l.range.start),
        to: cdmOffset(entry, l.range.end),
        x: x0 + l.box.x,
        y: y0 + l.box.y,
        width: l.box.width,
        height: l.box.height,
      }));
      const last = b.lines[b.lines.length - 1];
      if (last && last.range.end > entry.engineLength) mismatches.add(b.paragraphId);
      out.push({
        kind: 'paragraph',
        blockId: entry.blockId,
        from: lines[0]?.from ?? entry.start,
        to: lines[lines.length - 1]?.to ?? entry.start,
        x,
        y,
        width: b.box.width,
        height: b.box.height,
        lines,
      });
    } else {
      const entry = p.tables.get(b.tableId);
      if (!entry) {
        unknown.add(b.tableId);
        continue;
      }
      const tx = x0 + b.box.x;
      const ty = y0 + b.box.y;
      const rows: LayoutRow[] = b.rows.map((r) => ({
        rowId: entry.rows.get(r.id) ?? r.id,
        repeated: r.isHeaderRepeat,
        y: y0 + r.box.y,
        height: r.box.height,
        cells: r.cells
          .filter((c) => !c.vMergeContinue)
          .map((c) => ({
            cellId: entry.cells.get(c.id) ?? c.id,
            x: x0 + c.box.x,
            width: c.box.width,
            fragments: blocksToFragments(p, c.blocks, x0, y0, unknown, mismatches),
          })),
      }));
      out.push({
        kind: 'table',
        blockId: entry.table.id,
        x: tx,
        y: ty,
        width: b.box.width,
        height: b.box.height,
        rows,
      });
    }
  }
  return out;
}

/** Lays out a flow document with Eigenpal's core and returns the project's layout tree. */
export async function layoutWithEigenpal(
  doc: FlowDocument,
  measurer: TextMeasurer,
): Promise<EigenpalReport> {
  const projection = projectToOoxml(doc);
  const opened = openDocumentForExport(projection.bytes, {
    measurer: bridgeMeasurer(measurer),
    producer: measurer.id,
    reuseAcrossRevisions: false,
  });
  if (!opened.ok)
    throw new Error(
      `Eigenpal refused the projected package: ${opened.reason} ${opened.detail ?? ''}`,
    );
  try {
    const layout = (await opened.session.layout()) as unknown as ELayout;
    const unknown = new Set<string>();
    const mismatches = new Set<string>();
    const pages: LayoutPage[] = layout.pages.map((page, index) => {
      const cx = page.contentBox.x;
      const cy = page.contentBox.y;
      const story = (s: EStory | undefined): LayoutFragment[] =>
        s ? blocksToFragments(projection, s.fragments, s.box.x, s.box.y, unknown, mismatches) : [];
      return {
        index,
        section: 0,
        width: page.box.width,
        height: page.box.height,
        fragments: blocksToFragments(projection, page.fragments, cx, cy, unknown, mismatches),
        header: story(page.header),
        footer: story(page.footer),
        footnotes: (page.footnotes?.notes ?? []).flatMap((n) => story(n)),
      };
    });
    return {
      tree: freezeTree({ engine: EIGENPAL_ENGINE, measurer: measurer.id, pages }),
      projection: { bytes: projection.bytes.length, carriers: projection.carriers },
      unknownParagraphs: [...unknown],
      lengthMismatches: [...mismatches],
    };
  } finally {
    opened.session.dispose();
  }
}
