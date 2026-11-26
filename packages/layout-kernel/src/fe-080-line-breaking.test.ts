/**
 * FE-080: the bundled Unicode line breaking algorithm as the layout engine's break provider
 * (02 §9.3). The implementation is the kernel's (`kernel.segmenter`, WASM-007: UAX #14 of Unicode
 * 15.0.0, from the `unicode-linebreak` crate). Here it is plugged into the engine's own line breaker
 * (`packages/layout`), and checked against the cases of the Unicode Consortium's `LineBreakTest.txt`
 * that carry no-break spaces, hyphens, slashes and ideographs. Run in Node.js on the real build; the
 * whole file runs in `segmentation.test.ts` and, in four browsers, in
 * `e2e/wasm-007-segmentation-browsers.spec.ts`.
 *
 * Not shown here: the page view's default provider is still the placeholder of
 * `packages/element/src/page-view/providers.ts`, because the page thread does not load the kernel.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { breakParagraph, type BreakOpportunities } from '../../layout/src/items.ts';
import { fixedWidthMeasurer } from '../../layout/src/measure.ts';
import { kernelIsBuilt, loadNodeKernel } from '../node/index.ts';

const built = kernelIsBuilt();
if (process.env['DOCEDIT_KERNEL_REQUIRED'] === '1' && !built)
  throw new Error('dist/ is not built: run build:wasm first');

const DATA = resolve(import.meta.dirname, '../../../crates/layout-kernel/tests/data');
const FONT = { family: 'F', sizePt: 10, bold: false, italic: false };

interface Case {
  line: number;
  text: string;
  breaks: number[];
}

function readCases(): Case[] {
  const out: Case[] = [];
  readFileSync(resolve(DATA, 'unicode-15.0.0/LineBreakTest.txt'), 'utf8')
    .split('\n')
    .forEach((raw, index) => {
      const body = raw.split('#')[0]!.trim();
      if (body === '') return;
      let text = '';
      const breaks: number[] = [];
      for (const token of body.split(/\s+/)) {
        if (token === '÷') breaks.push(text.length);
        else if (token !== '×') text += String.fromCodePoint(Number.parseInt(token, 16));
      }
      out.push({ line: index + 1, text, breaks });
    });
  return out;
}

/** The lines the engine's first-fit breaker makes of `text` in a column of `columns` characters. */
function lines(provider: BreakOpportunities, text: string, columns: number): string[] {
  const result = breakParagraph(
    {
      blockId: 'b',
      runs: [{ text, font: FONT }],
      markFont: FONT,
      // The fixed-width measurer gives 5 points to a character at 10 points.
      columnWidth: columns * 5,
      line: { rule: 'multiple', factor: 1 },
    },
    fixedWidthMeasurer(),
    provider,
  );
  return result.lines.map((l) => text.slice(l.from, l.to));
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

describe('no Intl.Segmenter in the break path (FE-080 criterion 1)', () => {
  it('is not called by the layout engine, the kernel wrapper or the page view providers', () => {
    const roots = ['layout/src', 'layout-kernel/src', 'element/src/page-view'].map((p) =>
      resolve(import.meta.dirname, '../..', p),
    );
    const offenders = roots
      .flatMap(sources)
      .filter((file) =>
        /Intl\.Segmenter/.test(readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '')),
      );
    expect(offenders).toEqual([]);
  });
});

describe.skipIf(!built)("the kernel as the engine's break provider (FE-080)", () => {
  it('takes text and language in and gives offsets out, and runs in the engine unchanged', async () => {
    const kernel = await loadNodeKernel();
    const provider: BreakOpportunities = kernel.segmenter;
    expect(provider.opportunities('ab cd/ef gh ij kl')).toEqual([3, 6, 9, 15]);
    expect(provider.opportunities('ab cd', 'en-GB')).toEqual([3]);
    // Lines of at most 6 characters: after the slash (SY), not at the no-break space (GL).
    expect(lines(provider, 'ab cd/ef gh ij kl', 6)).toEqual(['ab cd/', 'ef ', 'gh ij ', 'kl']);
  });

  it('breaks after a hyphen between letters and between ideographs, as the classes say', async () => {
    const kernel = await loadNodeKernel();
    const provider = kernel.segmenter;
    expect(provider.opportunities('well-known')).toEqual([5]);
    expect(provider.opportunities('日本語')).toEqual([1, 2]);
    expect(lines(provider, 'well-known', 6)).toEqual(['well-', 'known']);
    expect(lines(provider, '日本語の文', 2)).toEqual(['日本', '語の', '文']);
  });

  it('passes every case of the Unicode line break test that holds a no-break space, hyphen, slash or ideograph', async () => {
    const kernel = await loadNodeKernel();
    const groups: Record<string, (text: string) => boolean> = {
      'no-break space (GL)': (t) => t.includes(' '),
      'hyphen-minus (HY)': (t) => t.includes('-'),
      'solidus (SY)': (t) => t.includes('/'),
      'ideograph (ID)': (t) => /[一-鿿]/.test(t),
    };
    const all = readCases();
    for (const [name, pick] of Object.entries(groups)) {
      const cases = all.filter((c) => pick(c.text));
      expect(cases.length, name).toBeGreaterThan(20);
      // The file marks the start of the text with `×` (LB2), so only later `÷` are opportunities.
      const failures = cases.filter((c) => {
        const expected = c.breaks.filter((offset) => offset > 0 && offset < c.text.length);
        const got = kernel.segmenter
          .opportunities(c.text)
          .filter((offset) => offset > 0 && offset < c.text.length);
        return expected.join() !== got.join();
      });
      expect(
        failures.map((c) => c.line),
        name,
      ).toEqual([]);
    }
  });
});
