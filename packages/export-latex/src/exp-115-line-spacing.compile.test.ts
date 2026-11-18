/**
 * EXP-115 criterion 1, line spacing: every case of the model's shared fixture `line-spacing.json`
 * run against the LaTeX writer, with the line height measured in the compiled PDF.
 *
 * A case lists the natural heights of the runs on one line. Here each run is a word set at the
 * font size whose natural height (the family's `lineHeight`, the rule `naturalHeight` in
 * `src/props.ts`) is that number of twips, as near as whole twips of font size allow. A paragraph
 * has two lines with the same runs, joined by a line break, and the distance between the same word
 * on the two lines (`pdftotext -bbox`) is the height of a line: both lines are alike, so the split
 * of the extra space above and below the text (open in ADR 0032) cancels out. The fixture's
 * `expected` is then compared with that distance, within 2 twips (one twip of font size is 1.36
 * twips of natural height, and a `multiple` of 1.5 carries that to 2). The natural heights that
 * the sizes give are asserted to be within one twip of the fixture's `runs`.
 *
 * The paragraph's own font (style Normal) is set to the size of the shortest run of the case. The
 * class makes the first line of a paragraph at least as tall as the paragraph font's natural height
 * (the `indent` box of `DE@par` carries the paragraph's run attributes, `DElh` in the style
 * macro), which the fixture does not do: its line is the tallest *run* only. With Normal at the
 * default 11 pt (natural 300 twips) over runs of natural 253 the first line is 7 twips taller, and
 * the test "first line ... default paragraph font" below records that as a known failure.
 *
 * The empty line has no word, so the paragraph is measured as the difference between a document
 * with an empty paragraph between two others and one without it; its height is that of the
 * paragraph mark, the paragraph font, so Normal is set to the case's run. An inline picture is a
 * PNG of the fixture's height.
 *
 * Node.js only; needs `lualatex`, the local font copy and `pdftotext` (`test/cdm-local-tex.ts`);
 * skips without them. Evidence:
 * `pnpm exec vitest run --project node packages/export-latex/src/exp-115-line-spacing.compile.test.ts`
 * with `DOCEDIT_LUALATEX` and `DOCEDIT_PDFTOTEXT` set when they are not on the PATH.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { doc, nid, para, type J } from '../test/docs.ts';
import {
  compileLocalAsync,
  convertLocal,
  localFonts,
  lualatexAvailable,
} from '../test/cdm-local-tex.ts';
import { makePng, sha256Hex } from '../test/exp-034-png.ts';
import { loadSemantics, pdftotextAvailable } from '../test/exp-115-fixtures.ts';

interface Case {
  readonly id: string;
  readonly description: string;
  readonly lineSpacing: number;
  readonly lineRule: 'multiple' | 'exact' | 'atLeast';
  readonly runs: readonly number[];
  readonly expected: number;
}

const CASES = loadSemantics<{ cases: Case[] }>('line-spacing').cases;
const TOL_TWIPS = 2;

const ready = lualatexAvailable() && pdftotextAvailable();

let familyCache: { lineHeight: number } | undefined;
/** The default family of the local font copy (read once: reading it checks every font file). */
function family(): { lineHeight: number } {
  if (!familyCache) {
    const fonts = localFonts();
    familyCache = fonts.families.find((f) => f.name === fonts.defaultFamily)!;
  }
  return familyCache;
}

/** The natural height of a run of `size` twips in the default family, as `naturalHeight` has it. */
function natural(size: number): number {
  return Math.floor((size * family().lineHeight + 500) / 1000);
}

/** The font size, in twips, whose natural height is nearest to `h`. */
function sizeFor(h: number): number {
  const guess = Math.round((h * 1000) / family().lineHeight);
  let best = guess;
  for (const s of [guess - 1, guess, guess + 1])
    if (Math.abs(natural(s) - h) < Math.abs(natural(best) - h)) best = s;
  return best;
}

interface Word {
  readonly text: string;
  readonly yMin: number;
}

/** The words of page 1 in reading order, from `pdftotext -bbox` (points from the top). */
function wordsOf(pdf: Uint8Array): Word[] {
  const dir = mkdtempSync(join(tmpdir(), 'docedit-exp-115-ls-'));
  const file = join(dir, 'in.pdf');
  writeFileSync(file, pdf);
  const r = spawnSync(
    process.env['DOCEDIT_PDFTOTEXT'] ?? 'pdftotext',
    ['-f', '1', '-l', '1', '-bbox', file, '-'],
    { encoding: 'utf8', timeout: 60_000, windowsHide: true },
  );
  if (r.error || r.status !== 0) throw new Error('pdftotext -bbox failed');
  return [
    ...r.stdout.matchAll(
      /<word xMin="[\d.]+" yMin="([\d.]+)" xMax="[\d.]+" yMax="[\d.]+">([^<]*)<\/word>/g,
    ),
  ].map((m) => ({ yMin: Number(m[1]), text: m[2]! }));
}

const PNG_ID = 'inline-picture-asset';

/** The style Normal at the font size whose natural height is `h`. */
const normalFor = (h: number): J => ({
  type: 'style_def',
  attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal', builtIn: true, fontSize: sizeFor(h) },
});

async function compile(body: J[], name: string, normal: J | null) {
  const png = makePng(40, 40);
  const assets = {
    [PNG_ID]: {
      sha256: sha256Hex(png),
      mediaType: 'image/png',
      status: 'ready' as const,
      bytes: png,
    },
  };
  const bundle = await convertLocal(doc(body, { styles: normal ? [normal] : [] }), {
    profile: 'preview',
    title: `exp-115-${name}`,
    instant: '2026-11-06T10:00:00.000Z',
    timeZone: 'Europe/London',
    suggestions: 'accept',
    layout: 'block',
    assets,
  } as never);
  const c = await compileLocalAsync(bundle, name);
  if (!c.ok) throw new Error(`the compile failed (${c.dir}):\n${c.log.slice(-1500)}`);
  return wordsOf(c.pdf!);
}

/** One run of a line: a word at the size for natural height `h`, or a picture of that height. */
function runNode(word: string, h: number, picture: boolean): J[] {
  if (picture)
    return [
      {
        type: 'image',
        attrs: { id: nid('i'), asset: PNG_ID, width: 720, height: h, alt: 'Inline picture' },
      },
    ];
  return [
    {
      type: 'text',
      text: `${word} `,
      marks: [{ type: 'fontSize', attrs: { value: sizeFor(h) } }],
    },
  ];
}

describe.skipIf(!ready)('EXP-115 criterion 1: line spacing measured in the PDF', () => {
  for (const c of CASES) {
    it.concurrent(
      `[line-spacing x LaTeX] ${c.id}`,
      async () => {
        const attrs = {
          lineSpacing: c.lineSpacing,
          lineRule: c.lineRule,
          spaceBefore: 0,
          spaceAfter: 0,
        };
        const shortest = Math.min(...c.runs);
        if (c.id === 'empty-line') {
          // The line of an empty paragraph, as the difference between two documents.
          const line = (text: string): J => para(text, attrs);
          const normal = normalFor(c.runs[0]!);
          const withEmpty = await compile(
            [line('Top'), para('', attrs), line('Bottom')],
            `${c.id}-with`,
            normal,
          );
          const without = await compile([line('Top'), line('Bottom')], `${c.id}-without`, normal);
          const gap = (w: Word[]): number =>
            (w.find((x) => x.text === 'Bottom')!.yMin - w.find((x) => x.text === 'Top')!.yMin) * 20;
          const extra = gap(withEmpty) - gap(without);
          expect(
            Math.abs(extra - c.expected),
            `empty line ${extra.toFixed(1)} twips, fixture ${c.expected}`,
          ).toBeLessThanOrEqual(TOL_TWIPS);
          return;
        }
        // The runs of one line, set twice with a line break between the lines.
        const picture = c.id === 'inline-picture';
        const line: J[] = c.runs.flatMap((h, i) => runNode(`R${i}`, h, picture && h === 1440));
        const content = [
          ...line,
          { type: 'break', attrs: { kind: 'line' } },
          ...line.map((n) => structuredClone(n)),
        ];
        // Each picture needs its own identifier.
        for (const n of content) if (n['type'] === 'image') (n['attrs'] as J)['id'] = nid('i');
        const words = await compile(
          [{ type: 'paragraph', attrs: { id: nid('p'), ...attrs }, content }],
          c.id,
          normalFor(shortest),
        );
        // The first text run is a word of the size of the first run; it is on both lines.
        const same = words.filter((w) => w.text === 'R0');
        expect(
          same.length,
          `the word R0 on both lines (${JSON.stringify(words.map((w) => w.text))})`,
        ).toBe(2);
        const pitch = (same[1]!.yMin - same[0]!.yMin) * 20;
        // The natural heights that the font sizes give are the fixture's, to a twip.
        for (const h of c.runs)
          if (!(picture && h === 1440))
            expect(Math.abs(natural(sizeFor(h)) - h)).toBeLessThanOrEqual(1);
        expect(
          Math.abs(pitch - c.expected),
          `line height ${pitch.toFixed(1)} twips, fixture ${c.expected}`,
        ).toBeLessThanOrEqual(TOL_TWIPS);
      },
      600_000,
    );
  }
});

/**
 * Known failure, kept as `it.fails` so that the suite turns red when it is fixed: with the paragraph
 * font at the default 11 pt, the first line of the `single` case is 300 twips high, not the 253 of
 * its only run (the `indent` box carries the paragraph's own run attributes). See the Notes of
 * EXP-115 and EXP-021.
 */
describe.skipIf(!ready)('EXP-115 criterion 1: the first line and the paragraph font', () => {
  it.fails(
    '[line-spacing x LaTeX] first line of a paragraph is the height of its runs, not of the default paragraph font',
    async () => {
      const c = CASES.find((x) => x.id === 'single')!;
      const attrs = {
        lineSpacing: c.lineSpacing,
        lineRule: c.lineRule,
        spaceBefore: 0,
        spaceAfter: 0,
      };
      const line = runNode('R0', c.runs[0]!, false);
      const content = [...line, { type: 'break', attrs: { kind: 'line' } }, ...line];
      const words = await compile(
        [{ type: 'paragraph', attrs: { id: nid('p'), ...attrs }, content }],
        'first-line',
        null,
      );
      const same = words.filter((w) => w.text === 'R0');
      expect(Math.abs((same[1]!.yMin - same[0]!.yMin) * 20 - c.expected)).toBeLessThanOrEqual(
        TOL_TWIPS,
      );
    },
    600_000,
  );
});
