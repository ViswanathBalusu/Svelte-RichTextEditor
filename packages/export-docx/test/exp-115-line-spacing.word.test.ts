/**
 * EXP-115 criterion 2, line spacing, DOCX side (EXP-090 criterion 6): every case of the model's
 * shared fixture `line-spacing.json` written by `writeDocx`, laid out by Microsoft Word 16 and
 * measured in the PDF it exports (`pdftotext -bbox`), as the LaTeX runner does
 * (`packages/export-latex/src/exp-115-line-spacing.compile.test.ts`).
 *
 * A case lists the natural heights of the runs on one line, in twips. Word has its own font metrics,
 * so the natural height of a font size is not the model's 1.15. One document of this run measures
 * Word's natural height for every font size from 6 to 70 pt in steps of half a point (a paragraph of
 * three lines at that size, single spacing; the distance between the first and the last line). Each
 * run of a case is then set at the size whose natural height in Word is nearest the fixture's. The
 * check has two parts:
 *  - the sizes are close: each chosen natural height is within 8 twips of the fixture's run (a step
 *    of half a point is 10 twips of size, about 12 of height), so the case is the fixture's;
 *  - the rule holds: the distance between the same word on two lines of the paragraph equals
 *    `lineHeight(spacing, chosen naturals)` of the model within 2 twips, and for `exact` and
 *    `atLeast` the fixture's own `expected` where the rule does not depend on a natural height
 *    (`exact`, and `atLeast` over a smaller run).
 * An inline picture is a PNG of the fixture's height; an empty line is the difference between a
 * document with an empty paragraph between two others and one without it.
 *
 * Node.js only, Windows with Word and `pdftotext`; skips without them (CI has no Word).
 * Evidence: `pnpm exec vitest run --project node packages/export-docx/test/exp-115-line-spacing.word.test.ts`.
 */
import { lineHeight } from '@docedit/model';
import { describe, expect, it } from 'vitest';
import { AssetStore } from '../src/index.ts';
import { makePng } from './writer-docs.ts';
import {
  type J,
  documentOf,
  layOutInWord,
  loadSemantics,
  wordAvailable,
  wordsOf,
} from './exp-115-word.ts';

interface Case {
  readonly id: string;
  readonly description: string;
  readonly lineSpacing: number;
  readonly lineRule: 'multiple' | 'exact' | 'atLeast';
  readonly runs: readonly number[];
  readonly expected: number;
}

const CASES = loadSemantics<{ cases: Case[] }>('line-spacing').cases;
const DIR = 'exp-115-line-spacing';
const TOL_TWIPS = 2;
const PICTURE = 1440;
/** The font sizes measured, in twips: 6 pt to 70 pt in half points. */
const SIZES: number[] = [];
for (let s = 120; s <= 1400; s += 10) SIZES.push(s);

let seq = 0;
const nid = (p: string): string => `${p}${String(++seq).padStart(15, 'x')}`.slice(0, 16);

const para = (content: J[], attrs: J = {}): J => ({
  type: 'paragraph',
  attrs: { id: nid('p'), spaceBefore: 0, spaceAfter: 0, ...attrs },
  content,
});
const run = (text: string, size: number): J => ({
  type: 'text',
  text,
  marks: [{ type: 'fontSize', attrs: { value: size } }],
});
const lineBreak = (): J => ({ type: 'break', attrs: { kind: 'line' } });
const normalAt = (size: number): J => ({
  type: 'style_def',
  attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal', builtIn: true, fontSize: size },
});

/**
 * Cases where Word and the fixture differ, with the reason. Each is asserted to still differ, by
 * the amount stated, so that a change on either side shows. The owner has not ruled on these
 * (decision 238 is about labels), so the fixture is not changed and the criterion stays open.
 */
const WORD_DIFFERS: Readonly<Record<string, { reason: string; extra: [number, number] }>> = {
  'inline-picture': {
    reason:
      'Word puts the picture on the baseline, so the line is the picture plus the descent of the text on it; the fixture says the line is the picture alone.',
    extra: [20, 80],
  },
};

const ready = wordAvailable();

describe.skipIf(!ready)('EXP-115 criterion 2: line spacing as Word lays it out', () => {
  let made: Promise<void> | undefined;
  /** Word's natural height of each size (twips), read from the calibration document. */
  const natural = new Map<number, number>();
  const sizeFor = (h: number): number => {
    let best = SIZES[0]!;
    for (const s of SIZES)
      if (Math.abs(natural.get(s)! - h) < Math.abs(natural.get(best)! - h)) best = s;
    return best;
  };

  /** The word `text` of a document, the nth one. */
  const at = (name: string, text: string): number[] =>
    wordsOf(DIR, name)
      .filter((w) => w.text === text)
      .map((w) => w.yMin);

  const laidOut = (): Promise<void> =>
    (made ??= (async () => {
      const png = makePng(40, 40);
      const store = new AssetStore();
      const pictureId = await store.add(png, 'image/png', 'image');
      const docs = new Map<string, { env: ReturnType<typeof documentOf>; assets?: AssetStore }>();
      const file = { styles: [normalAt(220)] };
      // Calibration: three lines of each size, single spacing.
      docs.set('calibration', {
        env: documentOf(file, {
          id: 'calibration',
          description: 'natural heights',
          body: SIZES.map((s) =>
            para(
              ['a', 'b', 'c'].flatMap((l, i) => [
                ...(i > 0 ? [lineBreak()] : []),
                run(`C${s}${l}`, s),
              ]),
              { lineSpacing: 1000, lineRule: 'multiple' },
            ),
          ),
        }),
      });
      // The sizes are known only after the calibration, so a second pass writes the cases: this
      // function lays out the calibration first, then the cases.
      await layOutInWord(`${DIR}-cal`, docs);
      for (const s of SIZES) {
        const a = wordsOf(`${DIR}-cal`, 'calibration');
        const ya = a.find((w) => w.text === `C${s}a`)?.yMin;
        const yc = a.find((w) => w.text === `C${s}c`)?.yMin;
        if (ya === undefined || yc === undefined) throw new Error(`calibration: size ${s} missing`);
        natural.set(s, ((yc - ya) / 2) * 20);
      }
      const cases = new Map<string, { env: ReturnType<typeof documentOf>; assets?: AssetStore }>();
      for (const c of CASES) {
        const attrs = { lineSpacing: c.lineSpacing, lineRule: c.lineRule };
        const picture = c.id === 'inline-picture';
        const shortest = sizeFor(Math.min(...c.runs.filter((h) => !(picture && h === PICTURE))));
        const styles = [normalAt(shortest)];
        if (c.id === 'empty-line') {
          const size = sizeFor(c.runs[0]!);
          const top = para([run('Top', size)], attrs);
          const bottom = para([run('Bottom', size)], attrs);
          cases.set(`${c.id}-with`, {
            env: documentOf(
              { styles: [normalAt(size)] },
              {
                id: c.id,
                description: c.description,
                body: [top, para([], attrs), bottom],
              },
            ),
          });
          cases.set(`${c.id}-without`, {
            env: documentOf(
              { styles: [normalAt(size)] },
              {
                id: c.id,
                description: c.description,
                body: [top, bottom],
              },
            ),
          });
          continue;
        }
        const line = (): J[] =>
          c.runs.flatMap((h, i): J[] =>
            picture && h === PICTURE
              ? [
                  {
                    type: 'image',
                    attrs: {
                      id: nid('i'),
                      asset: pictureId,
                      width: 720,
                      height: h,
                      alt: 'Picture',
                    },
                  },
                ]
              : [run(`R${i} `, sizeFor(h))],
          );
        cases.set(c.id, {
          env: documentOf(
            { styles },
            {
              id: c.id,
              description: c.description,
              body: [para([...line(), lineBreak(), ...line()], attrs)],
            },
          ),
          assets: store,
        });
      }
      await layOutInWord(DIR, cases);
    })());

  for (const c of CASES) {
    it(`[line-spacing x DOCX] ${c.id}${WORD_DIFFERS[c.id] ? ' (Word differs from the fixture)' : ''}`, async () => {
      await laidOut();
      const picture = c.id === 'inline-picture';
      const naturals = c.runs.map((h) =>
        picture && h === PICTURE ? PICTURE : natural.get(sizeFor(h))!,
      );
      // The chosen sizes stand for the fixture's runs.
      c.runs.forEach((h, i) =>
        expect(
          Math.abs(naturals[i]! - h),
          `run ${i}: ${naturals[i]} against ${h}`,
        ).toBeLessThanOrEqual(8),
      );
      const rule = { lineSpacing: c.lineSpacing, lineRule: c.lineRule };
      const ruleHeight = lineHeight(
        rule,
        naturals.map((n) => Math.round(n)),
      );
      let measured: number;
      if (c.id === 'empty-line') {
        const gap = (name: string): number => (at(name, 'Bottom')[0]! - at(name, 'Top')[0]!) * 20;
        measured = gap(`${c.id}-with`) - gap(`${c.id}-without`);
      } else {
        const ys = at(c.id, 'R0');
        expect(ys.length, `the word R0 on both lines of ${c.id}`).toBe(2);
        measured = (ys[1]! - ys[0]!) * 20;
      }
      const differs = WORD_DIFFERS[c.id];
      if (differs) {
        expect(
          measured - ruleHeight,
          `${differs.reason} Word ${measured.toFixed(1)} twips, fixture ${c.expected}`,
        ).toBeGreaterThanOrEqual(differs.extra[0]);
        expect(measured - ruleHeight).toBeLessThanOrEqual(differs.extra[1]);
        return;
      }
      expect(
        Math.abs(measured - ruleHeight),
        `Word: ${measured.toFixed(1)} twips; the rule of the model for Word's natural heights ${JSON.stringify(naturals)}: ${ruleHeight}; fixture ${c.expected}`,
      ).toBeLessThanOrEqual(TOL_TWIPS);
      // Where the fixture's number does not depend on a natural height, it is Word's too.
      if (
        c.lineRule === 'exact' ||
        (c.lineRule === 'atLeast' && Math.max(...naturals) < c.lineSpacing)
      )
        expect(Math.abs(measured - c.expected)).toBeLessThanOrEqual(TOL_TWIPS);
    }, 900_000);
  }
});
