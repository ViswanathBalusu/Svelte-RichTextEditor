/**
 * EXP-078 (lane V-EXP-065-080): compares the text positions of a compile with its stored reference
 * PDF, line by line and page by page, and reports the documents whose lines or page breaks moved.
 * Pure functions over the positions that `pdftotext -bbox-layout` gives (see exp-078-pdftotext.ts).
 * Pixels are not compared here; the criterion's "or pixels" is not covered by this module.
 */

export interface TextLine {
  text: string;
  xMin: number;
  yMin: number;
}

export interface PageText {
  page: number;
  lines: TextLine[];
}

export interface MovedLine {
  page: number;
  text: string;
  refX: number;
  refY: number;
  candX: number;
  candY: number;
}

export interface ChangedLine {
  page: number;
  index: number;
  refText: string;
  candText: string;
}

export interface PageBreakMove {
  page: number;
  refFirst: string;
  candFirst: string;
}

export interface TextDiff {
  pageCount: { ref: number; cand: number };
  /** Same text on the same line index, but at another position (beyond the tolerance). */
  moved: MovedLine[];
  /** Different text at the same line index, or a line missing on one side. */
  changed: ChangedLine[];
  /** The first line of a page is not the same text as in the reference. */
  breaks: PageBreakMove[];
  differs: boolean;
}

export interface CorpusEntry {
  document: string;
  diff: TextDiff;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** Decodes the XML character references that pdftotext writes into its XHTML. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (whole, body: string) => {
    if (body.startsWith('#x')) return String.fromCodePoint(parseInt(body.slice(2), 16));
    if (body.startsWith('#')) return String.fromCodePoint(parseInt(body.slice(1), 10));
    return NAMED_ENTITIES[body] ?? whole;
  });
}

function attribute(attrs: string, name: string): number {
  const m = new RegExp(`\\b${name}="([-0-9.]+)"`).exec(attrs);
  if (!m) throw new Error(`pdftotext output: no ${name} attribute in <line ${attrs}>`);
  return Number(m[1]);
}

/**
 * Reads the pages and lines of the XHTML written by `pdftotext -bbox-layout`. A line's text is its
 * words joined by single spaces, in the order pdftotext gives them.
 */
export function parsePages(xhtml: string): PageText[] {
  const pages: PageText[] = [];
  const parts = xhtml.split(/<page\b/).slice(1);
  parts.forEach((part, i) => {
    const lines: TextLine[] = [];
    for (const m of part.matchAll(/<line\b([^>]*)>([\s\S]*?)<\/line>/g)) {
      const attrs = m[1] ?? '';
      const body = m[2] ?? '';
      const words = [...body.matchAll(/<word\b[^>]*>([^<]*)<\/word>/g)].map((w) =>
        decodeEntities(w[1] ?? ''),
      );
      lines.push({
        text: words.join(' '),
        xMin: attribute(attrs, 'xMin'),
        yMin: attribute(attrs, 'yMin'),
      });
    }
    pages.push({ page: i + 1, lines });
  });
  return pages;
}

/**
 * Compares a candidate with its reference. A line is moved when its text is the same and its
 * position differs by more than `tolerance` points; a page break is moved when the first line of
 * the same page is a different text (or the page count differs).
 */
export function diffText(
  ref: readonly PageText[],
  cand: readonly PageText[],
  tolerance = 0.5,
): TextDiff {
  const moved: MovedLine[] = [];
  const changed: ChangedLine[] = [];
  const breaks: PageBreakMove[] = [];
  const pages = Math.max(ref.length, cand.length);
  for (let p = 0; p < pages; p++) {
    const r = ref[p];
    const c = cand[p];
    const rLines = r?.lines ?? [];
    const cLines = c?.lines ?? [];
    const pageNo = p + 1;
    const lineCount = Math.max(rLines.length, cLines.length);
    for (let i = 0; i < lineCount; i++) {
      const rl = rLines[i];
      const cl = cLines[i];
      if (rl && cl && rl.text === cl.text) {
        if (Math.abs(rl.yMin - cl.yMin) > tolerance || Math.abs(rl.xMin - cl.xMin) > tolerance) {
          moved.push({
            page: pageNo,
            text: rl.text,
            refX: rl.xMin,
            refY: rl.yMin,
            candX: cl.xMin,
            candY: cl.yMin,
          });
        }
      } else {
        changed.push({ page: pageNo, index: i, refText: rl?.text ?? '', candText: cl?.text ?? '' });
      }
    }
    const rFirst = rLines[0]?.text ?? '';
    const cFirst = cLines[0]?.text ?? '';
    if (r && c && rFirst !== cFirst)
      breaks.push({ page: pageNo, refFirst: rFirst, candFirst: cFirst });
  }
  const pageCount = { ref: ref.length, cand: cand.length };
  const differs =
    pageCount.ref !== pageCount.cand || moved.length > 0 || changed.length > 0 || breaks.length > 0;
  return { pageCount, moved, changed, breaks, differs };
}

/** The documents whose diff differs, in the order given. */
export function differingDocuments(entries: readonly CorpusEntry[]): CorpusEntry[] {
  return entries.filter((e) => e.diff.differs);
}

/**
 * The report of the corpus run: one block per differing document, naming each moved line (with its
 * old and new position) and each page break that moved. Returns the empty string when nothing
 * differs.
 */
export function formatReport(entries: readonly CorpusEntry[]): string {
  const out: string[] = [];
  for (const { document, diff } of differingDocuments(entries)) {
    if (diff.pageCount.ref !== diff.pageCount.cand)
      out.push(
        `${document}: page count ${diff.pageCount.ref} in the reference, ${diff.pageCount.cand} now`,
      );
    for (const m of diff.moved)
      out.push(
        `${document}: page ${m.page}, line "${m.text}" moved from y ${m.refY.toFixed(2)} to y ${m.candY.toFixed(2)}` +
          (m.refX !== m.candX ? ` and x ${m.refX.toFixed(2)} to ${m.candX.toFixed(2)}` : ''),
      );
    for (const c of diff.changed)
      out.push(
        `${document}: page ${c.page}, line ${c.index + 1} is "${c.candText}", was "${c.refText}"`,
      );
    for (const b of diff.breaks)
      out.push(
        `${document}: page break moved, page ${b.page} starts with "${b.candFirst}", was "${b.refFirst}"`,
      );
  }
  return out.join('\n');
}
