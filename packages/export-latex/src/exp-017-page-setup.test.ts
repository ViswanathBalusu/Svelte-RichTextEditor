/**
 * Page setups and page sections (Node.js only): EXP-017 criteria 1 to 5. The tests read main.tex
 * of the converter's bundle (the setup macros are in the preamble) and the house class source.
 * Nothing compiles: the page geometry in the PDF is not inspected, only the values the converter
 * writes and the macros the class defines.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { doc, nid, para, run, type J } from '../test/docs.ts';
import { dimen, ULENGTH_RANGE } from './emit.ts';

const CLASS = readFileSync(fileURLToPath(new URL('../class/docedit.cls', import.meta.url)), 'utf8');
const MAIN = 'main.tex';
/** The range the converter clamps a page size to (page.ts), in twips. */
const PAGE_RANGE = { min: 144, max: 31680 };

/** The class source with its comments removed, so that a macro named in a comment does not count. */
const CLASS_CODE = CLASS.split('\n')
  .map((l) => l.replace(/(^|[^\\])%.*$/, '$1'))
  .join('\n');

/** The arguments of `\<name>{k}{...}{...}`, where every argument is a braced group with no braces inside. */
function macroArgs(main: string, name: string, k: number): string[] {
  const re = new RegExp(`\\\\${name}\\{${k}\\}((?:\\{[^{}]*\\})+)`);
  const m = re.exec(main);
  if (m === null) throw new Error(`no \\${name}{${k}} in main.tex`);
  return [...m[1]!.matchAll(/\{([^{}]*)\}/g)].map((x) => x[1]!);
}

/** The section macro of a page section: `\DEsection{k}{start}`. */
function sectionOf(main: string): [string, string][] {
  return [...main.matchAll(/\\DEsection\{(\d+)\}\{(\d)\}/g)].map((m) => [m[1]!, m[2]!]);
}

/** A page setup with the given attributes. */
const setup = (id: string, attrs: J = {}): J => ({ type: 'page_setup', attrs: { id, ...attrs } });

/** The four-sided A4 setup of the tests, in twips. */
const A4: J = {
  width: 11906,
  height: 16838,
  marginTop: 1440,
  marginBottom: 1440,
  marginLeft: 1440,
  marginRight: 1440,
  gutter: 0,
  headerDistance: 720,
  footerDistance: 720,
};

/** A section break to a page setup, as a body node. */
const sectionBreak = (pageSetup: string, start?: string, extra: J = {}): J => ({
  type: 'section_break',
  attrs: { id: nid('s'), pageSetup, ...(start ? { start } : {}), ...extra },
});

describe('EXP-017 criterion 1: size, orientation, margins, gutter, distances, columns and column gap reach the setup macros', () => {
  it('writes every length of the first page setup through \\DEdefsetup and \\DEdefsetupb, with \\DEgeometry on it', async () => {
    const ps = setup('ps1', {
      ...A4,
      marginTop: 1134,
      marginBottom: 1134,
      marginLeft: 1701,
      marginRight: 1417,
      gutter: 284,
      headerDistance: 567,
      footerDistance: 567,
      columns: 2,
      columnGap: 708,
    });
    const bundle = await run(doc([para('body')], { pageSetups: [ps] }));
    const main = bundle.files[MAIN]!;
    const a = macroArgs(main, 'DEdefsetup', 0);
    // Order of \DEdefsetup: width, height, top, right, bottom, left, gutter, header distance.
    expect(a).toEqual([
      String(dimen(11906, PAGE_RANGE)),
      String(dimen(16838, PAGE_RANGE)),
      String(dimen(1134)),
      String(dimen(1417)),
      String(dimen(1134)),
      String(dimen(1701)),
      String(dimen(284)),
      String(dimen(567)),
    ]);
    const b = macroArgs(main, 'DEdefsetupb', 0);
    expect(b[0]).toBe(String(dimen(567)));
    expect(b[1]).toBe('2');
    expect(b[2]).toBe(String(dimen(708)));
    expect(main).toMatch(/\\DEgeometry\{0\}/);
    expect(main).toMatch(/\\DEstartsetup\{0\}/);
  });

  it('swaps the sides when orientation is landscape and the stored size is portrait', async () => {
    const bundle = await run(
      doc([para('body')], { pageSetups: [setup('ps1', { ...A4, orientation: 'landscape' })] }),
    );
    const [w, h] = macroArgs(bundle.files[MAIN]!, 'DEdefsetup', 0);
    expect(w).toBe(String(dimen(16838, PAGE_RANGE)));
    expect(h).toBe(String(dimen(11906, PAGE_RANGE)));
  });
});

describe('EXP-017 criterion 2: a section to a different size or orientation sets the page directly and starts a new page', () => {
  it('gives the section its own setup and starts it on a new page, with no \\newgeometry in the class', async () => {
    const sb = sectionBreak('ps2', 'nextPage');
    const bundle = await run(
      doc([para('before'), sb, para('after')], {
        pageSetups: [setup('ps1', A4), setup('ps2', { ...A4, orientation: 'landscape' })],
      }),
    );
    const main = bundle.files[MAIN]!;
    expect(sectionOf(main)).toEqual([['1', '0']]);
    const [w, h] = macroArgs(main, 'DEdefsetup', 1);
    expect(w).toBe(String(dimen(16838, PAGE_RANGE)));
    expect(h).toBe(String(dimen(11906, PAGE_RANGE)));
    // The class sets the size with \paperwidth and \paperheight at each section start (09 §3.1).
    expect(CLASS_CODE).not.toMatch(/\\newgeometry/);
    expect(CLASS_CODE).toMatch(/\\global\\paperwidth=\\DE@ps\{#1\}\{w\}/);
    expect(CLASS_CODE).toMatch(/\\global\\paperheight=\\DE@ps\{#1\}\{h\}/);
    expect(CLASS_CODE).toMatch(
      /\\newcommand\*\\DEsection\[2\]\{[\s\S]*?\\ifcase#2\\relax\s*\\clearpage\\DE@applysetup\{#1\}/,
    );
  });
});

describe('EXP-017 criterion 3: section starts map to next page, next even page and next odd page', () => {
  it.each([
    ['nextPage', '0'],
    ['evenPage', '1'],
    ['oddPage', '2'],
  ])('writes the code of %s as %s', async (start, code) => {
    const bundle = await run(
      doc([para('a'), sectionBreak('ps2', start), para('b')], {
        pageSetups: [setup('ps1', A4), setup('ps2', A4)],
      }),
    );
    expect(sectionOf(bundle.files[MAIN]!)).toEqual([['1', code]]);
  });

  it('the class starts an even-page section on the next even page and an odd-page one on the next odd page', () => {
    expect(CLASS_CODE).toMatch(
      /\\or \\clearpage\\ifodd\\c@page\\null\\clearpage\\fi\\DE@applysetup\{#1\}/,
    );
    expect(CLASS_CODE).toMatch(
      /\\or \\clearpage\\ifodd\\c@page\\else\\null\\clearpage\\fi\\DE@applysetup\{#1\}/,
    );
  });
});

describe('EXP-017 criterion 4: a continuous break that changes the margins is reported with its block identifier', () => {
  it('reports continuous_break_geometry with the break identifier and keeps the size and margins', async () => {
    const sb = sectionBreak('ps2', 'continuous');
    const bundle = await run(
      doc([para('a'), sb, para('b')], {
        pageSetups: [setup('ps1', A4), setup('ps2', { ...A4, marginLeft: 2880 })],
      }),
    );
    const d = bundle.diagnostics.find((x) => x.code === 'continuous_break_geometry');
    expect(d).toBeDefined();
    expect(d!.blockId).toBe(sb.attrs.id);
    expect(d!.severity).toBe('warning');
    expect(sectionOf(bundle.files[MAIN]!)).toEqual([['1', '3']]);
  });

  it('reports nothing when the continuous break changes only the columns', async () => {
    const sb = sectionBreak('ps2', 'continuous');
    const bundle = await run(
      doc([para('a'), sb, para('b')], {
        pageSetups: [setup('ps1', A4), setup('ps2', { ...A4, columns: 2, columnGap: 708 })],
      }),
    );
    expect(bundle.diagnostics.map((d) => d.code)).not.toContain('continuous_break_geometry');
    expect(sectionOf(bundle.files[MAIN]!)).toEqual([['1', '3']]);
  });
});

describe('EXP-017 criterion 5: every length of a page setup is written through the dimen emitter', () => {
  it('writes each width as the twips converted to big points, clamped to the page range', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 40000 }),
        fc.integer({ min: 0, max: 5000 }),
        async (w, m) => {
          // The height is the largest page size, so no width is larger and the sides are not swapped (03 §4.1).
          const bundle = await run(
            doc([para('x')], {
              pageSetups: [setup('ps1', { ...A4, width: w, height: 31680, marginLeft: m })],
            }),
          );
          const [width, , , , , left] = macroArgs(bundle.files[MAIN]!, 'DEdefsetup', 0);
          const clamped = Math.min(PAGE_RANGE.max, Math.max(PAGE_RANGE.min, w));
          expect(width).toBe(String(dimen(clamped, PAGE_RANGE)));
          expect(width).toMatch(/^\d+(\.\d+)?bp$/);
          expect(Math.abs(parseFloat(width!) - clamped / 20)).toBeLessThan(0.001);
          expect(left).toBe(String(dimen(m, ULENGTH_RANGE)));
        },
      ),
      { numRuns: 40 },
    );
  });
});
