/**
 * WASM-007: Unicode segmentation in the kernel, through the package's wrapper, on the real build in
 * Node.js. The conformance runs are the Unicode Consortium's own test files, kept as downloaded in
 * `crates/layout-kernel/tests/data/` (`SOURCES.json` names the URL, the version and the SHA-256 of
 * each): `LineBreakTest.txt` of Unicode 15.0.0 for UAX #14 and `GraphemeBreakTest.txt` of Unicode
 * 17.0.0 for UAX #29, the versions the two pinned crates implement. The same files run in native
 * Rust (`crates/layout-kernel/tests/segmentation.rs`); this is the run from TypeScript, through the
 * module, so that the layout engine and the kernel can be checked against each other.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { kernelIsBuilt, loadNodeKernel } from '../node/index.ts';
import { nextBoundary, previousBoundary } from './segmentation.ts';

const built = kernelIsBuilt();
if (process.env['DOCEDIT_KERNEL_REQUIRED'] === '1' && !built)
  throw new Error('dist/ is not built: run build:wasm first');

const DATA = resolve(import.meta.dirname, '../../../crates/layout-kernel/tests/data');

interface SourceFile {
  path: string;
  url: string;
  unicodeVersion: string;
  bytes: number;
  sha256: string;
}
const sources = JSON.parse(readFileSync(resolve(DATA, 'SOURCES.json'), 'utf8')) as {
  files: SourceFile[];
};
const source = (name: string): SourceFile => {
  const found = sources.files.find((f) => f.path.endsWith(`/${name}`));
  if (!found) throw new Error(`${name} is not in SOURCES.json`);
  return found;
};

interface Case {
  line: number;
  text: string;
  /** UTF-16 offsets of the `÷` marks. */
  breaks: number[];
}

/** The cases of a Unicode break test file: code points with `÷` (break) and `×` (no break) between. */
function readCases(file: SourceFile): Case[] {
  const out: Case[] = [];
  readFileSync(resolve(DATA, file.path), 'utf8')
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

describe('the Unicode test files (WASM-007)', () => {
  it('are the files SOURCES.json names: size, SHA-256 and the version in the header', () => {
    for (const file of sources.files) {
      const bytes = readFileSync(resolve(DATA, file.path));
      expect(bytes.length, file.path).toBe(file.bytes);
      expect(createHash('sha256').update(bytes).digest('hex'), file.path).toBe(file.sha256);
      expect(file.url, file.path).toBe(
        `https://www.unicode.org/Public/${file.unicodeVersion}/ucd/auxiliary/${file.path.split('/')[1]}`,
      );
      const header = bytes.toString('utf8').split('\n', 1)[0];
      expect(header, file.path).toContain(`-${file.unicodeVersion}.txt`);
    }
  });
});

describe.skipIf(!built)('segmentation in the kernel (WASM-007)', () => {
  it('records the Unicode versions of the data, and they are the versions of the test files', async () => {
    const kernel = await loadNodeKernel();
    expect(kernel.segmenter.unicode).toEqual({
      lineBreak: source('LineBreakTest.txt').unicodeVersion,
      grapheme: source('GraphemeBreakTest.txt').unicodeVersion,
    });
  });

  it('passes the Unicode grapheme cluster test (UAX #29, Unicode 17.0.0)', async () => {
    const kernel = await loadNodeKernel();
    const cases = readCases(source('GraphemeBreakTest.txt'));
    expect(cases.length).toBeGreaterThan(700);
    const failures = cases.filter(
      (c) => kernel.segmenter.graphemeBoundaries(c.text).join() !== c.breaks.join(),
    );
    expect(failures.map((c) => c.line)).toEqual([]);
  });

  it('passes the Unicode line break test (UAX #14, Unicode 15.0.0), every case', async () => {
    const kernel = await loadNodeKernel();
    const cases = readCases(source('LineBreakTest.txt'));
    expect(cases.length).toBe(7654);
    // The file marks the start of the text with `×` (rule LB2), so only later `÷` are opportunities.
    const failures = cases.filter((c) => {
      const expected = c.breaks.filter((offset) => offset > 0);
      return (
        kernel.segmenter
          .lineBreaks(c.text)
          .map((b) => b.offset)
          .join() !== expected.join()
      );
    });
    expect(failures.map((c) => c.line)).toEqual([]);
  });

  it('follows the rules the crate leaves out: numbers, wide brackets and unassigned pictographs', async () => {
    const { segmenter } = await loadNodeKernel();
    // LB25 as the test file has it (UAX #14, section 8.2, example 7): a number is kept whole,
    // and a separator, a bracket or a per cent sign beside no number holds nothing.
    expect(segmenter.opportunities('1,234.56% of')).toEqual([10]);
    expect(segmenter.opportunities('a.2')).toEqual([2]);
    expect(segmenter.opportunities('}%')).toEqual([1]);
    expect(segmenter.opportunities('%(a')).toEqual([1]);
    expect(segmenter.opportunities('%(1')).toEqual([]);
    expect(segmenter.opportunities('1.%')).toEqual([]);
    // LB30: a line may break before an opening bracket of East Asian width, not before `(`.
    expect(segmenter.opportunities('dog（犬）を')).toEqual([3, 6]);
    expect(segmenter.opportunities('dog(x) y')).toEqual([7]);
    // LB30b: an emoji modifier stays with an unassigned pictograph (U+1F02C).
    expect(segmenter.opportunities('\u{1f02c}\u{1f3ff}')).toEqual([]);
  });

  it('gives the break opportunities in the shape the layout engine and the breaker take', async () => {
    const { segmenter } = await loadNodeKernel();
    // The end of the text is an opportunity of `lineBreaks`, and is not one of `opportunities`.
    expect(segmenter.lineBreaks('Hello world!')).toEqual([
      { offset: 6, mandatory: false },
      { offset: 12, mandatory: true },
    ]);
    expect(segmenter.opportunities('Hello world!')).toEqual([6]);
    expect(segmenter.opportunities('Hello world!', 'en')).toEqual([6]);
    expect(segmenter.opportunities('')).toEqual([]);
    // A hard line break is a mandatory opportunity at the start of the next line.
    expect(segmenter.lineBreaks('a\nb')[0]).toEqual({ offset: 2, mandatory: true });
  });

  it('counts offsets in UTF-16 units, never inside a surrogate pair, and takes a lone surrogate as one unit', async () => {
    const { segmenter } = await loadNodeKernel();
    const text = '😀 x';
    expect(text.length).toBe(4);
    expect(segmenter.opportunities(text)).toEqual([3]);
    expect(segmenter.graphemeBoundaries(text)).toEqual([0, 2, 3, 4]);
    expect(segmenter.graphemeBoundaries('a\ud800b')).toEqual([0, 1, 2, 3]);
    expect(segmenter.graphemeBoundaries('')).toEqual([0]);
    // The same text as code units gives the same answer.
    expect(segmenter.graphemeBoundaries(new Uint16Array([0x61, 0xd800, 0x62]))).toEqual([
      0, 1, 2, 3,
    ]);
  });

  it('keeps a cluster whole for the caret and for deletion', async () => {
    const { segmenter } = await loadNodeKernel();
    // A base with two combining marks, a family emoji (a zero width joiner sequence) and CR LF.
    const text = 'é̂ 👨‍👩‍👧\r\nz';
    const boundaries = segmenter.graphemeBoundaries(text);
    expect(boundaries).toEqual([0, 3, 4, 12, 14, 15]);
    expect(nextBoundary(boundaries, 0)).toBe(3);
    expect(nextBoundary(boundaries, 1)).toBe(3);
    expect(nextBoundary(boundaries, 4)).toBe(12);
    expect(nextBoundary(boundaries, 15)).toBe(15);
    expect(previousBoundary(boundaries, 15)).toBe(14);
    expect(previousBoundary(boundaries, 14)).toBe(12);
    expect(previousBoundary(boundaries, 13)).toBe(12);
    expect(previousBoundary(boundaries, 0)).toBe(0);
  });

  it('is the same on a second kernel (nothing is shared or cached between calls)', async () => {
    const a = await loadNodeKernel();
    const b = await loadNodeKernel();
    const text = 'Lorem ipsum dolor sit amet,\nconsectetur — adipiscing elit. 日本語のテキスト';
    expect(a.segmenter.lineBreaks(text)).toEqual(b.segmenter.lineBreaks(text));
    expect(a.segmenter.lineBreaks(text)).toEqual(a.segmenter.lineBreaks(text));
  });
});
