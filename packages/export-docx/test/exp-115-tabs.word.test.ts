/**
 * EXP-115 criterion 2, tabs, DOCX side (EXP-090 criterion 6): every case of the model's shared
 * fixture `tabs.json` written by `writeDocx`, laid out by Microsoft Word 16 and measured in the PDF
 * it exports (`pdftotext -bbox`), as the LaTeX runner does
 * (`packages/export-latex/src/cdm-044-tabs.test.ts`).
 *
 * One document holds one paragraph per case, set as that runner sets it. A case with a tab at `x`
 * from the start of the segment gets an extra left stop at `x` (and the fixture's stops before it,
 * and a hanging indent that lies there), so that the tab of the case starts at `x`; the case's own
 * tab then goes from `x` as in the fixture. Each segment is one word `Q<n>` plus filler, read back
 * with `pdftotext -bbox`. A left segment (and one after a default or hanging stop) starts at its
 * position; a right segment ends at it; a centre segment is centred on it; the integer part of a
 * decimal segment ends at it (measured on a line of its own, with the same glyphs). A segment that
 * does not fit before the stop starts at `x`. Tolerance 1.5 pt, as the LaTeX runner (Word's PDF
 * export places text on a grid of about 0.12 pt).
 *
 * Not run: leaders (every case that is measured has `leader: none` here, so a leader's dots would
 * split the words; the leader of a case is written and Word reads it, but its dots are not
 * measured). Node.js only, Windows with Word and `pdftotext`; skips without them (CI has no Word).
 * Evidence: `pnpm exec vitest run --project node packages/export-docx/test/exp-115-tabs.word.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  type J,
  documentOf,
  layOutInWord,
  loadSemantics,
  wordAvailable,
  wordsOf,
} from './exp-115-word.ts';

interface Stop {
  readonly position: number;
  readonly align: 'left' | 'center' | 'right' | 'decimal';
  readonly leader: string;
}
interface Case {
  readonly id: string;
  readonly tabs: readonly Stop[];
  readonly indentLeft?: number;
  readonly indentFirstLine?: number;
  readonly x: number;
  readonly segment?: { readonly text?: string; readonly width?: number };
  readonly expected: {
    readonly position: number;
    readonly align?: string;
    readonly start?: number;
    readonly source: string;
  };
}

const FILE = loadSemantics<{ defaultTabStop: number; cases: Case[] }>('tabs');
const CASES = FILE.cases;
const DIR = 'exp-115-tabs';
const TWIPS_PER_PT = 20;
const TOL_PT = 1.5;
const LEFT_MARGIN_PT = 1440 / TWIPS_PER_PT;

const isDecimal = (c: Case): boolean =>
  c.expected.align === 'decimal' || c.tabs.some((t) => t.align === 'decimal');
const integerPart = (c: Case): string => (c.segment?.text ?? '').split('.')[0] ?? '';

let seq = 0;
const nid = (): string => `ptab${String(++seq).padStart(12, 'x')}`;
const para = (content: J[], attrs: J = {}): J => ({
  type: 'paragraph',
  attrs: { id: nid(), spaceBefore: 0, spaceAfter: 0, ...attrs },
  content,
});

/** The paragraph of one case: stops (the extra stop at `x` and the fixture's stops beyond it). */
function paragraphOf(index: number, c: Case): J {
  const start = (c.indentLeft ?? 0) + (c.indentFirstLine ?? 0);
  const word = isDecimal(c) ? `Q${index}${c.segment?.text ?? ''}` : `Q${index}${'w'.repeat(6)}`;
  const stops: J[] = c.tabs
    .filter((t) => t.position > c.x)
    .map((t) => ({ position: t.position, align: t.align, leader: 'none' }));
  const prefix = new Set<number>();
  if (c.x > start) {
    for (const t of c.tabs) if (t.position > start && t.position <= c.x) prefix.add(t.position);
    if (c.indentLeft !== undefined && c.indentLeft > start && c.indentLeft <= c.x)
      prefix.add(c.indentLeft);
    prefix.add(c.x);
  }
  const sorted = [...prefix].sort((a, b) => a - b);
  for (const position of sorted) stops.push({ position, align: 'left', leader: 'none' });
  const content: J[] = sorted.map(() => ({ type: 'tab' }));
  content.push({ type: 'tab' }, { type: 'text', text: word });
  // The fixture's `tabs` are in position order, and so are the stops written here.
  stops.sort((a, b) => (a['position'] as number) - (b['position'] as number));
  return para(content, {
    tabs: stops,
    indentLeft: c.indentLeft ?? 0,
    indentFirstLine: c.indentFirstLine ?? 0,
  });
}

/**
 * Cases where Word and the fixture differ, with the reason. The segment of each is asserted to start
 * where Word puts it (`startTw`, twips from the left margin), so that a change on either side shows,
 * and the same position is read from a paragraph with no helper stop (`Qd<n>`, one tab from the
 * start of the line), so that the difference is not an effect of the helper stop that the method
 * adds. The owner has not ruled on these, so the fixture is not changed and the criterion stays open.
 */
const WORD_DIFFERS: Readonly<Record<string, { reason: string; startTw: number }>> = {
  'hanging-indent-does-not-clear-default-stops': {
    reason:
      'In Word a hanging indent is a custom stop, and a custom stop clears the default stops before it: the tab from the start of the line goes to the hanging indent (2880), not to the default stop at 720 that the fixture expects.',
    startTw: 2880,
  },
};

describe.skipIf(!wordAvailable())('EXP-115 criterion 2: tab stops as Word lays them out', () => {
  let made: Promise<void> | undefined;
  const laidOut = (): Promise<void> =>
    (made ??= (async () => {
      const refs: J[] = CASES.flatMap((c, i) =>
        isDecimal(c) && (c.segment?.text ?? '').includes('.')
          ? [para([{ type: 'text', text: `Q${i}${integerPart(c)}` }])]
          : [],
      );
      // For a case where Word differs: one tab from the start of the line, with no helper stop.
      const direct: J[] = CASES.flatMap((c, i) =>
        WORD_DIFFERS[c.id]
          ? [
              para([{ type: 'tab' }, { type: 'text', text: `Qd${i}` }], {
                tabs: c.tabs.map((t) => ({ ...t, leader: 'none' })),
                indentLeft: c.indentLeft ?? 0,
                indentFirstLine: c.indentFirstLine ?? 0,
              }),
            ]
          : [],
      );
      const body = [...CASES.map((c, i) => paragraphOf(i, c)), ...refs, ...direct];
      await layOutInWord(
        DIR,
        new Map([
          [
            'tabs',
            {
              env: documentOf(
                { settings: { defaultTabStop: FILE.defaultTabStop } },
                { id: 'tabs', description: 'tab stops', body },
              ),
            },
          ],
        ]),
      );
    })());

  for (const [i, cs] of CASES.entries()) {
    it(`[tabs x DOCX] ${cs.id}${WORD_DIFFERS[cs.id] ? ' (Word differs from the fixture)' : ''}`, async () => {
      await laidOut();
      const words = wordsOf(DIR, 'tabs');
      const decimal = isDecimal(cs);
      const w = decimal
        ? words.find((x) => x.text === `Q${i}${cs.segment?.text ?? ''}`)
        : words.find((x) => x.text.startsWith(`Q${i}w`));
      expect(w, `${cs.id}: the segment is on the page`).toBeTruthy();
      const align = decimal ? 'decimal' : (cs.expected.align ?? 'left');
      const widthTw = (w!.xMax - w!.xMin) * TWIPS_PER_PT;
      let beforeTw = widthTw;
      if (decimal && (cs.segment?.text ?? '').includes('.')) {
        const ref = words.find((x) => x.text === `Q${i}${integerPart(cs)}`);
        expect(ref, `${cs.id}: the integer part is on the page`).toBeTruthy();
        beforeTw = (ref!.xMax - ref!.xMin) * TWIPS_PER_PT;
      }
      const startTw =
        align === 'right'
          ? Math.max(cs.x, cs.expected.position - widthTw)
          : align === 'center'
            ? Math.max(cs.x, cs.expected.position - widthTw / 2)
            : align === 'decimal'
              ? Math.max(cs.x, cs.expected.position - beforeTw)
              : (cs.expected.start ?? cs.expected.position);
      const differs = WORD_DIFFERS[cs.id];
      if (differs) {
        const at = LEFT_MARGIN_PT + differs.startTw / TWIPS_PER_PT;
        const d = words.find((x) => x.text === `Qd${i}`);
        expect(d, `${cs.id}: the direct paragraph is on the page`).toBeTruthy();
        expect(Math.abs(w!.xMin - at), `${differs.reason} Word: ${w!.xMin} pt`).toBeLessThanOrEqual(
          TOL_PT,
        );
        expect(
          Math.abs(d!.xMin - at),
          `${differs.reason} Word, direct: ${d!.xMin} pt`,
        ).toBeLessThanOrEqual(TOL_PT);
        return;
      }
      const expected = LEFT_MARGIN_PT + startTw / TWIPS_PER_PT;
      expect(
        Math.abs(w!.xMin - expected),
        `${cs.id}: segment starts at ${w!.xMin.toFixed(2)} pt, expected ${expected.toFixed(2)} pt`,
      ).toBeLessThanOrEqual(TOL_PT);
    }, 900_000);
  }
});
