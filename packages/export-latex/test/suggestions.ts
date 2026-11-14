/**
 * Helpers for the suggestion tests (Node.js only): suggestion marks, runs, tables, and the text a
 * bundle prints. The text is read from the `\DEstr` strings of main.tex, which is where the
 * converter writes the document's characters.
 */
import type { Bundle } from '../src/bundle.ts';
import { nid, para, type J } from './docs.ts';

/** An insertion mark with a 16-character identifier, from `alice`. */
export function insMark(n: number): J {
  return { type: 'ins', attrs: { id: `sTestIns${String(n).padStart(8, '0')}`, user: 'alice' } };
}

/** A deletion mark with a 16-character identifier, from `alice`. */
export function delMark(n: number): J {
  return { type: 'del', attrs: { id: `sTestDel${String(n).padStart(8, '0')}`, user: 'alice' } };
}

/** A text node, with marks when given. */
export function text(value: string, marks: J[] = []): J {
  return marks.length > 0 ? { type: 'text', text: value, marks } : { type: 'text', text: value };
}

/** A paragraph with the given node marks. */
export function markedPara(value: string, marks: J[]): J {
  return { ...para(value), marks };
}

/** A table of one-paragraph cells, one row per entry; a row or the table may carry marks. */
export function tableOf(rows: Array<{ cells: string[]; marks?: J[] }>, marks: J[] = []): J {
  return {
    type: 'table',
    attrs: { id: nid('t'), grid: [2880, 2880] },
    ...(marks.length > 0 ? { marks } : {}),
    content: rows.map((r) => ({
      type: 'table_row',
      attrs: { id: nid('r') },
      ...(r.marks && r.marks.length > 0 ? { marks: r.marks } : {}),
      content: r.cells.map((c) => ({
        type: 'table_cell',
        attrs: { id: nid('c') },
        content: [para(c)],
      })),
    })),
  };
}

/**
 * The body text the bundle prints: the content of every `\DEr{offset}{...}` chunk of main.tex, in
 * order. Body text is written as plain TeX (escaped where needed), so the chunks hold the words; a
 * chunk that holds braces or a macro is not read (the tests use plain words). Explicit spaces
 * (`\ `) are read as spaces.
 */
export function printed(b: Bundle): string {
  const out: string[] = [];
  for (const m of (b.files['main.tex'] ?? '').matchAll(/\\DEr\{\d+\}\{([^{}]*)\}/g)) {
    out.push(m[1]!.replace(/\\ /g, ' '));
  }
  return out.join('');
}
