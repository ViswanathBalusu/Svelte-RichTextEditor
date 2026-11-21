/**
 * WASM-007: the kernel's segmentation checked against the layout engine's side, over the shared
 * corpus. Node.js only; it reads the kernel's build (`pnpm --filter @docedit/layout-kernel
 * build:wasm`) and the harness's font files.
 *
 * - The break opportunities of every paragraph the engine breaks while it lays out a corpus
 *   document (the text it passes to its `LineBreaker`) are compared between the kernel and
 *   `linebreak` 1.1.0, the library of spike S10 that recorded the golden files before the kernel
 *   found them itself. The kernel finds every opportunity the library finds. It finds a few more,
 *   and each is of one kind: the kernel follows the number rules of the Unicode test file (UAX #14,
 *   section 8.2, example 7), where a separator or a closing bracket that belongs to no number does
 *   not hold what follows it, and the library keeps the pairs of the older rule together.
 * - The engine lays a document out with the kernel's segmenter as its `BreakOpportunities`
 *   provider, and the page it makes is the page it makes with the S10 library (none of the extra
 *   opportunities is where a line of that document ends).
 * - The kernel's grapheme cluster boundaries are the ones `Intl.Segmenter` gives for the same
 *   text. That is a cross-check, not the conformance run: the version of Unicode of Node.js's ICU
 *   is not the kernel's, so the comparison is made on the corpus, and the Unicode test files are
 *   the test of the algorithm (`packages/layout-kernel/src/segmentation.test.ts`).
 */
import { loadDocument } from '@docedit/corpus';
import { firstFitBreaker, layoutFlow, toFlow, type CdmEnvelopeLike } from '@docedit/layout';
import { beforeAll, describe, expect, it } from 'vitest';
import { kernelIsBuilt, loadNodeKernel } from '../../layout-kernel/node/index.ts';
import type { LayoutKernel } from '../../layout-kernel/src/index.ts';
import {
  DOCUMENTS,
  corpusMeasurer,
  loadHarnessFaces,
  recordParagraphs,
  toKernelInput,
  uax14,
} from './support/kernel-reference.ts';

const built = kernelIsBuilt();
if (process.env['DOCEDIT_KERNEL_REQUIRED'] === '1' && !built)
  throw new Error('dist/ is not built: run build:wasm first');

describe.skipIf(!built)('the kernel’s segmentation against the engine’s side (WASM-007)', () => {
  let kernel: LayoutKernel;
  const texts: Record<string, string[]> = {};
  beforeAll(async () => {
    kernel = await loadNodeKernel();
    loadHarnessFaces(kernel);
    const measurer = corpusMeasurer(kernel);
    for (const name of DOCUMENTS)
      texts[name] = (await recordParagraphs(name, measurer)).map((p) => toKernelInput(p).text);
  }, 120_000);

  it('finds every break opportunity of the corpus that linebreak 1.1.0 finds, and more only by the number rules', () => {
    // An opportunity that only the kernel finds must be one of these, read from the characters on
    // both sides of it: a separator outside a number before a digit (`footnote.1`), or a closing
    // bracket outside a number before a prefix or postfix (`{n}\right`).
    const separatorThenDigit = /(^|[^0-9.,:;/])[.,:;/]+$/;
    const bracketThenPrefix = /(^|[^0-9.,:;/])[.,:;/]*[)\]}]$/;
    const explained = (text: string, offset: number): boolean => {
      const before = text.slice(0, offset);
      const after = text.charAt(offset);
      if (/[0-9]/.test(after)) return separatorThenDigit.test(before);
      if (/[$+\\%]/.test(after)) return bracketThenPrefix.test(before);
      return false;
    };
    let paragraphs = 0;
    let opportunities = 0;
    const extra: string[] = [];
    for (const name of DOCUMENTS)
      for (const [i, text] of texts[name]!.entries()) {
        const mine = kernel.segmenter.opportunities(text);
        const theirs = new Set(uax14.opportunities(text));
        const where = `${name} paragraph ${i}: ${text.slice(0, 60)}`;
        expect(
          [...theirs].filter((o) => !mine.includes(o)),
          where,
        ).toEqual([]);
        for (const offset of mine.filter((o) => !theirs.has(o))) {
          expect(explained(text, offset), `${where}, offset ${offset}`).toBe(true);
          extra.push(
            `${text.slice(Math.max(0, offset - 6), offset)}|${text.slice(offset, offset + 6)}`,
          );
        }
        paragraphs++;
        opportunities += mine.length;
      }
    expect(paragraphs).toBeGreaterThan(600);
    expect(opportunities).toBeGreaterThan(5000);
    // Three places in the corpus as it is now; the list is here so that a reader sees them.
    expect(extra).toEqual(['tnote.|1 Its ', 'ditor.|8', '{1}{n}|\\right']);
  });

  it('lays a document out with the kernel as the engine’s break provider and gets the same pages', async () => {
    const envelope = (await loadDocument('pages-20')).envelope as unknown as CdmEnvelopeLike;
    const measurer = corpusMeasurer(kernel);
    const lay = (breaks: typeof uax14): ReturnType<typeof layoutFlow> =>
      layoutFlow(toFlow(envelope), { measurer, breaks, lineBreaker: firstFitBreaker });
    const withKernel = lay(kernel.segmenter);
    const withLibrary = lay(uax14);
    expect(withKernel.tree.pages.length).toBeGreaterThan(10);
    expect(JSON.stringify(withKernel)).toBe(JSON.stringify(withLibrary));
  });

  it('gives the grapheme cluster boundaries that Intl.Segmenter gives for the corpus text', () => {
    const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
    let checked = 0;
    for (const name of DOCUMENTS)
      for (const [i, text] of texts[name]!.entries()) {
        const expected = [...segmenter.segment(text)].map((s) => s.index);
        expected.push(text.length);
        expect(kernel.segmenter.graphemeBoundaries(text), `${name} paragraph ${i}`).toEqual(
          text === '' ? [0] : expected,
        );
        checked++;
      }
    expect(checked).toBeGreaterThan(600);
  });
});
