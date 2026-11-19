/**
 * WASM-008: the kernel's first-fit line breaker against the layout engine's own, over the shared
 * corpus, and the golden line starts that lock the result. Node.js only; it reads the kernel's
 * build (`pnpm --filter @docedit/layout-kernel build:wasm`) and the harness's font files.
 *
 * Every paragraph the engine breaks while laying out a corpus document is recorded (the input it
 * passes to its `LineBreaker`), and broken again by the kernel and by the engine's `breakParagraph`
 * with the kernel's own advances (whole advance units, so that both work in exact integers). The
 * two must agree on every line start, line width and line position. Break opportunities are UAX #14
 * (`linebreak` 1.1.0, the library of spike S10); producing them in the kernel is WASM-007.
 *
 * The golden file `golden/wasm-008-line-starts.json` holds the line starts of every paragraph; it is
 * rewritten when `DOCEDIT_UPDATE_GOLDEN=1`, and a change to it is a deliberate one.
 */
import { loadDocument } from '@docedit/corpus';
import {
  firstFitBreaker,
  layoutFlow,
  toFlow,
  type BreakOpportunities,
  type CdmEnvelopeLike,
  type FontKey,
  type LineBreaker,
  type ParagraphInput as EngineParagraph,
  type TextMeasurer,
} from '@docedit/layout';
import {
  KERNEL_FILES,
  createKernel,
  type KernelGlue,
  type LayoutKernel,
  type ParagraphInput,
  type ParagraphRun,
} from '../../layout-kernel/src/index.ts';
import LineBreakerLib from 'linebreak';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { kernelTextMeasurer } from '../../element/src/kernel-measure.ts';
import { fontManifest, resolveFace } from '../src/fonts.ts';

const pkg = resolve(import.meta.dirname, '..');
const dist = resolve(pkg, '../layout-kernel/dist');
const built = existsSync(resolve(dist, KERNEL_FILES.wasm));
const goldenFile = join(import.meta.dirname, 'golden', 'wasm-008-line-starts.json');
const DOCUMENTS = ['pages-1', 'form-fields', 'pages-20'] as const;
const UNITS = 1280;

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const aliasOf = (file: string): string =>
  `de-font-${fontManifest.fonts.find((f) => f.file === file)!.sha256}`;
const units = (points: number): number => Math.round(points * UNITS);
const twips = (sizePt: number): number => Math.max(1, Math.round(sizePt * 20));

/** UAX #14 break opportunities, as the layout engine's provider interface wants them. */
const uax14: BreakOpportunities = {
  opportunities(text) {
    const out: number[] = [];
    const breaker = new LineBreakerLib(text);
    for (let b = breaker.nextBreak(); b; b = breaker.nextBreak())
      if (b.position < text.length) out.push(b.position);
    return out;
  },
};

let kernel: LayoutKernel;
let providerForCorpus: TextMeasurer;
const aliasFor = (font: FontKey): string => aliasOf(resolveFace(font).file);

beforeAll(async () => {
  if (!built) return;
  const glue = (await import(
    `${pathToFileURL(resolve(dist, KERNEL_FILES.module)).href}?run=${Math.random()}`
  )) as KernelGlue;
  kernel = createKernel(glue, new Uint8Array(readFileSync(resolve(dist, KERNEL_FILES.wasm))));
  for (const f of fontManifest.fonts) {
    const bytes = new Uint8Array(readFileSync(join(pkg, 'fonts', f.file)));
    kernel.faces.load('', aliasOf(f.file), sha256(bytes), bytes);
  }
  // The engine's measurer for the recording pass: the kernel, with the corpus's families mapped to faces.
  const inner = kernelTextMeasurer(kernel);
  const map = (font: FontKey): FontKey => ({ ...font, family: aliasFor(font) });
  providerForCorpus = {
    id: inner.id,
    advance: (font, text) => inner.advance(map(font), text),
    advances: (font, text) => inner.advances(map(font), text),
    lineMetrics: (font) => inner.lineMetrics(map(font)),
  };
});

/** The paragraphs the engine breaks while it lays the document out. */
async function recorded(name: string): Promise<EngineParagraph[]> {
  const envelope = (await loadDocument(name)).envelope as unknown as CdmEnvelopeLike;
  const inputs: EngineParagraph[] = [];
  const recording: LineBreaker = {
    id: 'recording',
    breakParagraph(input, measurer, breaks) {
      inputs.push(input);
      return firstFitBreaker.breakParagraph(input, measurer, breaks);
    },
  };
  layoutFlow(toFlow(envelope), {
    measurer: providerForCorpus,
    breaks: uax14,
    lineBreaker: recording,
  });
  return inputs;
}

/** The kernel's input for an engine paragraph, in advance units. */
function toKernel(input: EngineParagraph): ParagraphInput {
  const text = input.runs.map((r) => r.text).join('');
  const runs: ParagraphRun[] = input.runs
    .filter((r) => r.text.length > 0)
    .map((r) => ({
      length: r.text.length,
      alias: aliasFor(r.font),
      sizeTwips: twips(r.font.sizePt),
      language: '',
      features: '',
      ...(r.width !== undefined ? { boxWidth: units(r.width) } : {}),
    }));
  return {
    text,
    runs,
    opportunities: uax14.opportunities(text, input.language),
    columnWidth: units(input.columnWidth),
    indentLeft: units(input.indentLeft ?? 0),
    indentRight: units(input.indentRight ?? 0),
    indentFirstLine: units(input.indentFirstLine ?? 0),
    defaultTabStop: units(input.defaultTabStop ?? 0),
    tabStops: (input.tabStops ?? []).map((s) =>
      typeof s === 'number'
        ? { position: units(s), align: 'left' as const }
        : { position: units(s.position), align: s.align },
    ),
  };
}

/** The same paragraph for the engine's breaker, with every length a whole number of advance units. */
function toEngineUnits(input: EngineParagraph): EngineParagraph {
  const ticks = (v: number | undefined): number | undefined =>
    v === undefined ? undefined : units(v);
  return {
    ...input,
    columnWidth: units(input.columnWidth),
    indentLeft: units(input.indentLeft ?? 0),
    indentRight: units(input.indentRight ?? 0),
    indentFirstLine: units(input.indentFirstLine ?? 0),
    defaultTabStop: units(input.defaultTabStop ?? 0),
    tabStops: (input.tabStops ?? []).map((s) =>
      typeof s === 'number' ? units(s) : { ...s, position: units(s.position) },
    ),
    runs: input.runs.map((r) => ({
      ...r,
      ...(r.width !== undefined ? { width: ticks(r.width)! } : {}),
    })),
  };
}

/** The engine's measurer reading advance units as if they were points, so that its sums are exact integers. */
function unitMeasurer(): TextMeasurer {
  return {
    id: 'kernel-units',
    advance: (font, text) =>
      text.length === 0
        ? 0
        : kernel.shaper.width(
            { alias: aliasFor(font), sizeTwips: twips(font.sizePt), language: '', features: '' },
            text,
          ),
    lineMetrics: () => ({ ascent: 0, descent: 0, lineGap: 0 }),
  };
}

const hasCentredStop = (input: EngineParagraph): boolean =>
  (input.tabStops ?? []).some((s) => typeof s !== 'number' && s.align === 'center');

describe.skipIf(!built)(
  'the kernel’s line breaks against the engine’s, over the corpus (WASM-008)',
  () => {
    for (const name of DOCUMENTS)
      it(`gives the engine’s line starts, widths and positions for every paragraph of ${name}`, async () => {
        const paragraphs = await recorded(name);
        expect(paragraphs.length).toBeGreaterThan(0);
        const measurer = unitMeasurer();
        let lines = 0;
        let centred = 0;
        let ties = 0;
        for (const [i, input] of paragraphs.entries()) {
          const where = `${name} paragraph ${i} (${input.blockId})`;
          const mine = kernel.shaper.breakParagraph(toKernel(input));
          if (hasCentredStop(input)) {
            // A centred stop rounds half its text to whole twips, as the model does: the engine does it
            // in points, which the unit-scaled reference cannot do exactly. Such a paragraph is
            // compared in points, on its line starts (a line that fits to within a unit could differ).
            centred++;
            const inPoints = firstFitBreaker.breakParagraph(input, providerForCorpus, uax14);
            const want = JSON.stringify(inPoints.lines.map((l) => [l.from, l.to]));
            if (JSON.stringify(mine.map((l) => [l.from, l.to])) !== want) {
              // The one cause allowed: a line that exactly fills the width left to it (a right stop at
              // the margin). The kernel's integers keep that tie; the engine's floating-point sums of
              // 451.3 and the like can lose it by the last bit.
              const room = units(input.columnWidth) - units(input.indentRight ?? 0);
              expect(
                mine.some((l) => l.x + l.width === room),
                where,
              ).toBe(true);
              ties++;
            }
          } else {
            const reference = firstFitBreaker.breakParagraph(toEngineUnits(input), measurer, uax14);
            expect(
              mine.map((l) => [l.from, l.to]),
              where,
            ).toEqual(reference.lines.map((l) => [l.from, l.to]));
            expect(
              mine.map((l) => [l.x, l.width]),
              where,
            ).toEqual(reference.lines.map((l) => [l.x, l.width]));
          }
          lines += mine.length;
        }
        expect(lines).toBeGreaterThan(0);
        expect(centred).toBeLessThan(paragraphs.length);
        expect(ties).toBeLessThanOrEqual(centred);
      });

    it('locks the line starts of the corpus in a golden file', async () => {
      const golden: Record<string, Array<[string, number[]]>> = {};
      for (const name of DOCUMENTS) {
        golden[name] = (await recorded(name)).map((input) => [
          input.blockId,
          kernel.shaper.breakParagraph(toKernel(input)).map((l) => l.from),
        ]);
      }
      if (process.env['DOCEDIT_UPDATE_GOLDEN'] === '1') {
        mkdirSync(join(import.meta.dirname, 'golden'), { recursive: true });
        writeFileSync(
          goldenFile,
          JSON.stringify(
            {
              $comment:
                "Line starts (UTF-16 offsets of each block's text) of every paragraph of the shared corpus, broken by the kernel (first fit, UAX #14 opportunities of linebreak 1.1.0, Noto Serif and its manifest faces). WASM-008. Rewritten by DOCEDIT_UPDATE_GOLDEN=1 on purpose only.",
              documents: golden,
            },
            null,
            0,
          ) + '\n',
        );
      }
      const locked = JSON.parse(readFileSync(goldenFile, 'utf8')) as {
        documents: typeof golden;
      };
      for (const name of DOCUMENTS) {
        expect(locked.documents[name], name).toBeDefined();
        expect(golden[name]!.length, name).toBe(locked.documents[name]!.length);
        for (const [i, [blockId, starts]] of golden[name]!.entries())
          expect(starts, `${name} paragraph ${i} (${blockId})`).toEqual(
            locked.documents[name]![i]![1],
          );
      }
    });
  },
);
