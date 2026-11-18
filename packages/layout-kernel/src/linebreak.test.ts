/**
 * WASM-008: first-fit line breaking in the kernel. These tests start the real build of the crate in
 * Node.js and break paragraphs set in Noto Serif. The rule itself has native tests in
 * crates/layout-kernel/src/linebreak.rs; the comparison with the layout engine's own breaker over
 * the shared corpus, and the golden line starts, are in packages/perf/test/wasm-008-kernel-breaks.test.ts.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ATOM_UNIT,
  KERNEL_FILES,
  KernelShapeError,
  blockText,
  createKernel,
  type KernelGlue,
  type LayoutKernel,
  type ParagraphInput,
  type ParagraphRun,
} from './index.ts';

const dist = resolve(import.meta.dirname, '../dist');
const fonts = resolve(import.meta.dirname, '../../perf/fonts/files');
const built = existsSync(resolve(dist, KERNEL_FILES.wasm));
const required = process.env['DOCEDIT_KERNEL_REQUIRED'] === '1';
if (required && !built) throw new Error('dist/ is not built: run build:wasm first');

const UNITS_PER_POINT = 1280;
const pt = (points: number): number => Math.round(points * UNITS_PER_POINT);

async function withSerif(): Promise<LayoutKernel> {
  const glue = (await import(
    `${pathToFileURL(resolve(dist, KERNEL_FILES.module)).href}?run=${Math.random()}`
  )) as KernelGlue;
  const kernel = createKernel(glue, new Uint8Array(readFileSync(resolve(dist, KERNEL_FILES.wasm))));
  const bytes = new Uint8Array(readFileSync(resolve(fonts, 'NotoSerif-Regular.ttf')));
  kernel.faces.load('', 'serif', createHash('sha256').update(bytes).digest('hex'), bytes);
  return kernel;
}

/** Break opportunities after each run of spaces: a stand-in for UAX #14 in these tests. */
function afterSpaces(text: string): number[] {
  const out: number[] = [];
  for (let i = 1; i < text.length; i++) if (text[i - 1] === ' ' && text[i] !== ' ') out.push(i);
  return out;
}

const run = (length: number, over: Partial<ParagraphRun> = {}): ParagraphRun => ({
  length,
  alias: 'serif',
  sizeTwips: 240,
  language: '',
  features: '',
  ...over,
});

function paragraph(text: string, over: Partial<ParagraphInput> = {}): ParagraphInput {
  return {
    text,
    runs: [run(text.length)],
    opportunities: afterSpaces(text),
    columnWidth: pt(200),
    ...over,
  };
}

const PROSE =
  'Typography is the craft of arranging type to make written language legible, readable and appealing when displayed. ' +
  'The arrangement of type involves selecting typefaces, point sizes, line lengths, line spacing and letter spacing.';

describe.skipIf(!built)('the kernel breaks paragraphs by first fit (WASM-008)', () => {
  it('returns line starts and widths that cover the text in order and fit the line', async () => {
    const kernel = await withSerif();
    const lines = kernel.shaper.breakParagraph(paragraph(PROSE));
    expect(lines.length).toBeGreaterThan(3);
    expect(lines[0]!.from).toBe(0);
    expect(lines.at(-1)!.to).toBe(PROSE.length);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (i > 0) expect(line.from).toBe(lines[i - 1]!.to);
      // A line without its trailing spaces fits the column, unless it is a single word that overflows.
      const text = PROSE.slice(line.from, line.to).trimEnd();
      if (text.includes(' ')) expect(line.width).toBeLessThanOrEqual(pt(200));
      // Its width is what the kernel measures for the text.
      expect(line.width).toBe(
        kernel.shaper.width({ alias: 'serif', sizeTwips: 240, language: '', features: '' }, text),
      );
      // Every line but the last ends at a break opportunity.
      if (i < lines.length - 1) expect(afterSpaces(PROSE)).toContain(line.to);
    }
  });

  it('is first fit: the next word would not have fitted', async () => {
    const kernel = await withSerif();
    const style = { alias: 'serif', sizeTwips: 240, language: '', features: '' };
    const lines = kernel.shaper.breakParagraph(paragraph(PROSE));
    for (const [i, line] of lines.slice(0, -1).entries()) {
      const next = afterSpaces(PROSE).find((o) => o > line.to) ?? PROSE.length;
      expect(next, `line ${i}`).toBeDefined();
      const more = PROSE.slice(line.from, next).trimEnd();
      expect(kernel.shaper.width(style, more), `line ${i}`).toBeGreaterThan(pt(200));
    }
  });

  it('counts an inline atom as one unit and a bookmark as none, in offsets and in widths', async () => {
    const kernel = await withSerif();
    const text = blockText([
      { kind: 'text', text: 'See the figure ' },
      { kind: 'bookmark' },
      { kind: 'atom' },
      { kind: 'text', text: ' above and then the next paragraph continues here.' },
    ]);
    expect(text).toBe(
      `See the figure ${ATOM_UNIT} above and then the next paragraph continues here.`,
    );
    expect(text.length).toBe(15 + 1 + 50);
    const atomAt = 15;
    const box = pt(60);
    const lines = kernel.shaper.breakParagraph({
      text,
      runs: [run(15), run(1, { boxWidth: box }), run(text.length - 16)],
      opportunities: afterSpaces(text),
      columnWidth: pt(120),
    });
    expect(lines[0]!.from).toBe(0);
    expect(lines.at(-1)!.to).toBe(text.length);
    const holder = lines.find((l) => l.from <= atomAt && atomAt < l.to)!;
    // The atom is on one line, whole, and that line is as wide as the text before it plus the box.
    const before = text.slice(holder.from, atomAt);
    const style = { alias: 'serif', sizeTwips: 240, language: '', features: '' };
    const after = text.slice(atomAt + 1, holder.to).trimEnd();
    expect(holder.width).toBeGreaterThanOrEqual(kernel.shaper.width(style, before) + box);
    expect(holder.width).toBeLessThanOrEqual(
      kernel.shaper.width(style, before) + box + kernel.shaper.width(style, after) + 1,
    );
  });

  it('reports the space a justified line needs and the spaces that share it, never for the last line', async () => {
    const kernel = await withSerif();
    const lines = kernel.shaper.breakParagraph(paragraph(PROSE, { justify: true }));
    for (const line of lines.slice(0, -1)) {
      const text = PROSE.slice(line.from, line.to);
      const spaces = text.trimEnd().split(' ').length - 1;
      expect(line.spaces).toBe(spaces);
      expect(line.extra).toBe(pt(200) - line.width);
      expect(line.wordSpacing).toBeCloseTo(line.extra / spaces, 9);
      // Setting that spacing on each of those spaces brings the line to the column's edge.
      expect(Math.round(line.width + line.wordSpacing * spaces)).toBe(pt(200));
    }
    const last = lines.at(-1)!;
    expect([last.extra, last.spaces, last.wordSpacing]).toEqual([0, 0, 0]);
    // Not asked for: no line reports spacing.
    expect(
      kernel.shaper.breakParagraph(paragraph(PROSE)).every((l) => l.extra === 0 && l.spaces === 0),
    ).toBe(true);
  });

  it('does not stretch tabs, trailing spaces or a line without a space', async () => {
    const kernel = await withSerif();
    const text = 'Header\tvalue that goes on and on for a good while so it must wrap onto lines ';
    const lines = kernel.shaper.breakParagraph(
      paragraph(text, { justify: true, columnWidth: pt(110), defaultTabStop: pt(36) }),
    );
    for (const line of lines.slice(0, -1)) {
      const part = text.slice(line.from, line.to);
      const trimmed = part.replace(/[ \t\u00a0]+$/, '');
      const stretchable = (trimmed.match(/[ \u00a0]/g) ?? []).length;
      expect(line.spaces).toBe(line.extra > 0 ? stretchable : 0);
    }
    const word = kernel.shaper.breakParagraph(
      paragraph('Unbreakable', { justify: true, columnWidth: pt(300) }),
    );
    expect(word).toHaveLength(1);
    expect(word[0]!.spaces).toBe(0);
  });

  it('advances tabs to the stops and to the document’s default tab stop', async () => {
    const kernel = await withSerif();
    const style = { alias: 'serif', sizeTwips: 240, language: '', features: '' };
    const text = 'Name\tValue';
    const word = (s: string): number => kernel.shaper.width(style, s);
    const withStop = kernel.shaper.breakParagraph(
      paragraph(text, { tabStops: [{ position: pt(100), align: 'left' }] }),
    )[0]!;
    expect(withStop.width).toBe(pt(100) + word('Value'));
    // Past the last stop the default spacing applies: the next multiple of 36 pt after "Name".
    const stepped = kernel.shaper.breakParagraph(paragraph(text, { defaultTabStop: pt(36) }))[0]!;
    expect(stepped.width).toBe(pt(36) + word('Value'));
    // A right stop puts the end of the text on it; a decimal stop puts the full stop on it.
    const right = kernel.shaper.breakParagraph(
      paragraph(text, { tabStops: [{ position: pt(100), align: 'right' }] }),
    )[0]!;
    expect(right.width).toBe(pt(100));
    const decimal = kernel.shaper.breakParagraph(
      paragraph('Sum\t12.50', { tabStops: [{ position: pt(100), align: 'decimal' }] }),
    )[0]!;
    expect(decimal.width).toBe(pt(100) - word('12') + word('12.50'));
    // A tab with no stop and no default spacing has no width.
    expect(kernel.shaper.breakParagraph(paragraph(text))[0]!.width).toBe(
      word('Name') + word('Value'),
    );
  });

  it('indents the first line on its own and narrows every line by the right indent', async () => {
    const kernel = await withSerif();
    const lines = kernel.shaper.breakParagraph(
      paragraph(PROSE, {
        indentLeft: pt(20),
        indentRight: pt(10),
        indentFirstLine: pt(15),
      }),
    );
    expect(lines[0]!.x).toBe(pt(35));
    expect(lines[1]!.x).toBe(pt(20));
    for (const line of lines) expect(line.x + line.width).toBeLessThanOrEqual(pt(200) - pt(10) + 1);
    const hanging = kernel.shaper.breakParagraph(
      paragraph(PROSE, { indentLeft: pt(30), indentFirstLine: -pt(20) }),
    );
    expect(hanging[0]!.x).toBe(pt(10));
  });

  it('breaks at a newline and gives an empty paragraph one empty line', async () => {
    const kernel = await withSerif();
    const lines = kernel.shaper.breakParagraph(paragraph('first\nsecond\n'));
    expect(lines.map((l) => [l.from, l.to])).toEqual([
      [0, 6],
      [6, 13],
      [13, 13],
    ]);
    expect(kernel.shaper.breakParagraph(paragraph(''))).toEqual([
      { from: 0, to: 0, x: 0, width: 0, extra: 0, spaces: 0, wordSpacing: 0 },
    ]);
  });

  it('shapes each run in its own face and size', async () => {
    const kernel = await withSerif();
    const text = 'small and LARGE words';
    const small = kernel.shaper.breakParagraph({
      text,
      runs: [run(10), run(11, { sizeTwips: 480 })],
      opportunities: afterSpaces(text),
      columnWidth: pt(1000),
    })[0]!;
    const style = (sizeTwips: number) => ({
      alias: 'serif',
      sizeTwips,
      language: '',
      features: '',
    });
    expect(small.width).toBe(
      kernel.shaper.width(style(240), text.slice(0, 10)) +
        kernel.shaper.width(style(480), text.slice(10)),
    );
  });

  it('refuses a request whose arrays do not agree, and a face it does not hold', async () => {
    const kernel = await withSerif();
    const code = (call: () => unknown): string => {
      try {
        call();
      } catch (error) {
        return error instanceof KernelShapeError ? error.code : 'other';
      }
      return 'none';
    };
    expect(code(() => kernel.shaper.breakParagraph({ ...paragraph('abc'), runs: [run(2)] }))).toBe(
      'other',
    );
    expect(
      code(() =>
        kernel.shaper.breakParagraph({ ...paragraph('abc'), runs: [run(3, { alias: 'nowhere' })] }),
      ),
    ).toBe('unknown_face');
  });

  it('reuses cached shaping when an edited paragraph is broken again', async () => {
    const kernel = await withSerif();
    const stats = () => kernel.shaper.cacheStats();
    kernel.shaper.breakParagraph(paragraph(PROSE));
    const cold = stats().misses;
    expect(cold).toBeGreaterThan(20);
    // The same paragraph again shapes nothing.
    kernel.shaper.breakParagraph(paragraph(PROSE));
    expect(stats().misses).toBe(cold);
    // One word of the last line is changed: only what the edit touches is shaped again.
    const edited = PROSE.replace('letter spacing', 'letter-spacing and kerning');
    kernel.shaper.breakParagraph(paragraph(edited));
    const warm = stats().misses - cold;
    expect(warm).toBeGreaterThan(0);
    expect(warm).toBeLessThan(cold / 3);
    // The same edit made on a cold kernel shapes as much as the first break did.
    const fresh = await withSerif();
    fresh.shaper.breakParagraph(paragraph(edited));
    expect(fresh.shaper.cacheStats().misses).toBeGreaterThan(warm * 3);
  });
});
