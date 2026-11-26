/**
 * WASM-012 criteria 3 and 4: the kernel's memory and its time per keystroke in a 100-page document,
 * measured against the shares proposed below. Node.js only; it reads the kernel's build
 * (`pnpm --filter @docedit/layout-kernel build:wasm`) and the harness's font files.
 *
 * The document is the corpus's `pages-20` five times over (100 pages), the last four copies with a
 * digit put in front of each paragraph so that no text is shared and the cache holds every one. The
 * kernel shapes and breaks all of it; then 300 keystrokes of S10's kind are timed. What is
 * measured is the kernel's linear memory (faces and shape cache included) and the kernel's calls
 * (segmentation, shaping and first-fit breaking of the edited paragraph), not the page view's
 * JavaScript heap, the worker's message round trip or the painter.
 *
 * The shares are proposals for the owner to confirm. Time: S10's share of the typing budget (4 ms
 * at the median, 12.5 ms at the 95th percentile, ADR 0016). Memory: a fifth of the 300 MB target
 * of 13 §9, 60 MB, a figure chosen here because no document sets one. The measured figures go to
 * `test-results/evidence/wasm-012-kernel-100-pages.json` (not tracked).
 */
import type { ParagraphInput as EngineParagraph } from '@docedit/layout';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { kernelIsBuilt, loadNodeKernel } from '../../layout-kernel/node/index.ts';
import type { LayoutKernel } from '../../layout-kernel/src/index.ts';
import {
  corpusMeasurer,
  loadHarnessFaces,
  recordParagraphs,
  toKernelInput,
} from './support/kernel-reference.ts';

const built = kernelIsBuilt();
if (process.env['DOCEDIT_KERNEL_REQUIRED'] === '1' && !built)
  throw new Error('dist/ is not built: run build:wasm first');

/** The proposed shares (see above). */
const MEMORY_SHARE_BYTES = 60 * 1024 * 1024;
const KEYSTROKE_MEDIAN_MS = 4;
const KEYSTROKE_P95_MS = 12.5;
const COPIES = 5;
const KEYSTROKES = 300;

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};
const percentile = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * p) - 1)]!;
};

/** The paragraph with its text starting with `mark`, so that its text is not another copy's. */
function marked(p: EngineParagraph, mark: string): EngineParagraph {
  const first = p.runs.findIndex((r) => r.text.length > 0 && r.width === undefined);
  if (first < 0) return p;
  return {
    ...p,
    runs: p.runs.map((r, i) => (i === first ? { ...r, text: mark + r.text } : r)),
  };
}

describe.skipIf(!built)('the kernel in a 100-page document (WASM-012)', () => {
  let kernel: LayoutKernel;
  let paragraphs: EngineParagraph[] = [];
  const figures: Record<string, unknown> = {};

  beforeAll(async () => {
    kernel = await loadNodeKernel();
    loadHarnessFaces(kernel);
    const one = await recordParagraphs('pages-20', corpusMeasurer(kernel));
    const all: EngineParagraph[] = [];
    for (let copy = 0; copy < COPIES; copy++)
      for (const p of one) all.push(copy === 0 ? p : marked(p, String(copy)));
    paragraphs = all;
  }, 120_000);

  it('holds the shaping and breaking of 100 pages under the memory share', () => {
    const afterFaces = kernel.memoryBytes()!;
    kernel.shaper.clearCache();
    let lines = 0;
    let codeUnits = 0;
    for (const p of paragraphs) {
      const input = toKernelInput(p);
      codeUnits += input.text.length;
      lines += kernel.shaper.breakParagraph(input).length;
    }
    const stats = kernel.shaper.cacheStats();
    const afterDocument = kernel.memoryBytes()!;
    figures['memory'] = {
      paragraphs: paragraphs.length,
      codeUnits,
      lines,
      faces: kernel.faces.count(),
      linearMemoryAfterFacesBytes: afterFaces,
      linearMemoryAfterDocumentBytes: afterDocument,
      cache: stats,
      shareBytes: MEMORY_SHARE_BYTES,
    };
    expect(lines).toBeGreaterThan(5 * 1000);
    expect(stats.entries).toBeGreaterThan(paragraphs.length / 2);
    expect(afterDocument).toBeLessThanOrEqual(MEMORY_SHARE_BYTES);
  });

  it('breaks an edited paragraph within S10’s share of the typing budget', () => {
    const lengthOf = (p: EngineParagraph): number => p.runs.reduce((n, r) => n + r.text.length, 0);
    const candidates = paragraphs.filter((p) => p.runs.every((r) => r.width === undefined));
    const nearest = (target: number): EngineParagraph =>
      candidates.reduce((best, p) =>
        Math.abs(lengthOf(p) - target) < Math.abs(lengthOf(best) - target) ? p : best,
      );
    const results: Record<string, { median: number; p95: number; max: number; length: number }> =
      {};
    for (const [name, target] of [
      ['paragraph575', 575],
      ['paragraphLongest', Number.MAX_SAFE_INTEGER],
    ] as const) {
      const base = nearest(target);
      const text = base.runs.map((r) => r.text).join('');
      const times: number[] = [];
      // Ten keystrokes warm the module's code paths; each of the others adds a letter to the end
      // of the last text run, so that no answer is in the cache for the changed text.
      const lastIndex = base.runs.map((r) => r.text.length).findLastIndex((n) => n > 0);
      const runs = base.runs.map((r) => ({ ...r }));
      for (let k = -10; k < KEYSTROKES; k++) {
        const run = runs[lastIndex]!;
        runs[lastIndex] = { ...run, text: run.text + 'abcdefghijklmnopqrstuvwxyz'[(k + 10) % 26] };
        const edited: EngineParagraph = { ...base, runs: runs.map((r) => r) };
        const joined = edited.runs.map((r) => r.text).join('');
        const t0 = performance.now();
        const opportunities = kernel.segmenter.opportunities(joined, edited.language);
        const input = { ...toKernelInput(edited), opportunities };
        kernel.shaper.breakParagraph(input);
        const dt = performance.now() - t0;
        if (k >= 0) times.push(dt);
      }
      results[name] = {
        median: median(times),
        p95: percentile(times, 0.95),
        max: Math.max(...times),
        length: text.length,
      };
      expect(results[name]!.median).toBeLessThanOrEqual(KEYSTROKE_MEDIAN_MS);
      expect(results[name]!.p95).toBeLessThanOrEqual(KEYSTROKE_P95_MS);
    }
    figures['keystroke'] = {
      keystrokes: KEYSTROKES,
      shareMedianMs: KEYSTROKE_MEDIAN_MS,
      shareP95Ms: KEYSTROKE_P95_MS,
      node: process.versions.node,
      ...results,
    };
    const dir = resolve(import.meta.dirname, '../test-results/evidence');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, 'wasm-012-kernel-100-pages.json'),
      JSON.stringify(figures, null, 2) + '\n',
    );
  }, 120_000);
});
