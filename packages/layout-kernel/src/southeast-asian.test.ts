/**
 * WASM-016 criteria 2 and 3: Thai, Lao, Khmer and Burmese break at word boundaries found with the
 * ICU4X dictionaries (owner decision 282), and the dictionaries are in a module of their own that is
 * loaded only when a document uses one of the scripts. Runs on the real build in Node.js. The crate
 * has its own tests (`crates/sea-segmenter/src/lib.rs`); these check the package's wrapper, the
 * merge with the kernel's answer and the on-demand loading.
 */
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  KERNEL_DIST,
  kernelIsBuilt,
  loadNodeKernel,
  loadNodeSoutheastAsian,
  readKernelWasm,
  readSoutheastAsianWasm,
  southeastAsianIsBuilt,
} from '../node/index.ts';
import {
  lazySoutheastAsian,
  usesSoutheastAsian,
  withSoutheastAsian,
  type SoutheastAsianBreaker,
} from './southeast-asian.ts';

const built = kernelIsBuilt() && southeastAsianIsBuilt();
if (process.env['DOCEDIT_KERNEL_REQUIRED'] === '1' && !built)
  throw new Error('dist/ is not built: run build:wasm first');

/** A sample: the script, the sentence, and the offsets before which a line may break (end excluded). */
const SAMPLES: ReadonlyArray<readonly [string, string, readonly number[]]> = [
  ['Thai', 'ฉันกินข้าว', [3, 6]],
  ['Thai', 'สวัสดีครับทุกคนยินดีต้อนรับ', [6, 10, 13, 15, 20]],
  ['Lao', 'ຂ້ອຍກິນເຂົ້າ', [4]],
  ['Khmer', 'ខ្ញុំញុំាបាយ', [5, 9]],
  ['Burmese', 'ကျွန်တော်ထမင်းစားတယ်', [9, 17]],
];

describe.skipIf(!built)('Thai, Lao, Khmer and Burmese (WASM-016)', () => {
  for (const [script, text, offsets] of SAMPLES) {
    it(`${script}: ${text} breaks at the words of the dictionary`, async () => {
      const sea = await loadNodeSoutheastAsian();
      expect(sea.breaks(text)).toEqual(offsets);
    });
  }

  it('the kernel alone finds no break inside these scripts, and the merge adds the dictionary', async () => {
    const kernel = await loadNodeKernel();
    const sea = await loadNodeSoutheastAsian();
    for (const [, text, offsets] of SAMPLES) {
      expect(kernel.segmenter.opportunities(text)).toEqual([]);
      expect(withSoutheastAsian(kernel.segmenter, sea).opportunities(text)).toEqual(offsets);
    }
  });

  it('merges with the kernel in a sentence that mixes scripts, once at each offset', async () => {
    const kernel = await loadNodeKernel();
    const sea = await loadNodeSoutheastAsian();
    const merged = withSoutheastAsian(kernel.segmenter, sea);
    const text = 'Eat: ฉันกินข้าว! and ຂ້ອຍກິນເຂົ້າ.';
    const base = kernel.segmenter.opportunities(text);
    const both = merged.opportunities(text);
    expect(both).toEqual([...new Set(both)].sort((a, b) => a - b));
    for (const offset of base) expect(both).toContain(offset);
    expect(both).toContain(8);
    expect(both).toContain(11);
    // The text outside the runs is the kernel's answer, and the mandatory end is kept.
    const flat = merged.lineBreaks(text);
    expect(flat.at(-1)).toEqual({ offset: text.length, mandatory: true });
    expect(flat.filter((b) => b.mandatory)).toHaveLength(1);
  });

  it('takes a language tag and a typed array as the kernel does', async () => {
    const kernel = await loadNodeKernel();
    const sea = await loadNodeSoutheastAsian();
    const merged = withSoutheastAsian(kernel.segmenter, sea);
    const units = Uint16Array.from('ฉันกินข้าว', (c) => c.charCodeAt(0));
    expect(merged.opportunities('ฉันกินข้าว', 'th')).toEqual([3, 6]);
    expect(merged.lineBreaks(units, 'th').map((b) => b.offset)).toEqual([3, 6, 10]);
    expect(merged.graphemeBoundaries(units)).toEqual(kernel.segmenter.graphemeBoundaries(units));
  });

  it('refuses nothing for text without these scripts and does not call the module', async () => {
    const sea = await loadNodeSoutheastAsian();
    expect(sea.breaks('Hello world 日本語')).toEqual([]);
    expect(sea.breaks('')).toEqual([]);
    expect(sea.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('keeps the dictionaries out of the kernel (criterion 3)', () => {
    const kernel = readKernelWasm();
    const sea = readSoutheastAsianWasm();
    // The dictionary module is the large one; the kernel is the size it was before this story.
    expect(sea.length).toBeGreaterThan(kernel.length);
    expect(kernel.length).toBeLessThan(1_100_000);
    expect(gzipSync(kernel, { level: 9 }).length).toBeLessThanOrEqual(427_000);
    expect(KERNEL_DIST).toContain('layout-kernel');
  });
});

describe('usesSoutheastAsian and the on-demand holder (WASM-016)', () => {
  const fake: SoutheastAsianBreaker = { version: '0.0.0', breaks: () => [] };

  it('tells the four scripts from the rest', () => {
    expect(usesSoutheastAsian('ฉัน')).toBe(true);
    expect(usesSoutheastAsian('ຂ້ອຍ')).toBe(true);
    expect(usesSoutheastAsian('ខ្ញុំ')).toBe(true);
    expect(usesSoutheastAsian('ကျွန်တော်')).toBe(true);
    expect(usesSoutheastAsian(Uint16Array.of(0x61, 0x0e01))).toBe(true);
    expect(usesSoutheastAsian('Hello, 日本語, العربية, 한국어')).toBe(false);
    expect(usesSoutheastAsian(Uint16Array.of(0x61, 0x62))).toBe(false);
    expect(usesSoutheastAsian('')).toBe(false);
  });

  it('never loads the module for a document that does not use the scripts', async () => {
    let calls = 0;
    const lazy = lazySoutheastAsian(() => {
      calls++;
      return Promise.resolve(fake);
    });
    expect(await lazy.ensure(['Hello', '日本語 テキスト', ''])).toBe(false);
    expect(calls).toBe(0);
    expect(lazy.requested).toBe(false);
    expect(lazy.loaded).toBe(false);
  });

  it('loads the module once, when the first text needs it', async () => {
    let calls = 0;
    const lazy = lazySoutheastAsian(() => {
      calls++;
      return Promise.resolve(fake);
    });
    const first = lazy.ensure(['Hello', 'ฉันกินข้าว']);
    const second = lazy.ensure(['ຂ້ອຍ']);
    expect(lazy.requested).toBe(true);
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(await lazy.ensure(['more ฉัน'])).toBe(true);
    expect(calls).toBe(1);
    expect(lazy.loaded).toBe(true);
  });

  it('tries again after a failed load, and again after a release', async () => {
    let calls = 0;
    const lazy = lazySoutheastAsian(() => {
      calls++;
      return calls === 1 ? Promise.reject(new Error('offline')) : Promise.resolve(fake);
    });
    await expect(lazy.ensure(['ฉัน'])).rejects.toThrow('offline');
    expect(lazy.loaded).toBe(false);
    expect(await lazy.ensure(['ฉัน'])).toBe(true);
    expect(calls).toBe(2);
    lazy.release();
    expect(lazy.loaded).toBe(false);
    expect(await lazy.ensure(['ฉัน'])).toBe(true);
    expect(calls).toBe(3);
  });

  it('gives the kernel answer before the load and the merged answer after it', async () => {
    const base = {
      unicode: { lineBreak: '15.0.0', grapheme: '17.0.0' },
      lineBreaks: (text: string | Uint16Array) => [{ offset: text.length, mandatory: true }],
      opportunities: () => [],
      graphemeBoundaries: () => [0],
    };
    const lazy = lazySoutheastAsian(() =>
      Promise.resolve({ version: '1.0.0', breaks: () => [2, 4] }),
    );
    const segmenter = lazy.segmenter(base);
    expect(segmenter.opportunities('ฉันกินข้าว')).toEqual([]);
    await lazy.ensure(['ฉันกินข้าว']);
    expect(segmenter.opportunities('ฉันกินข้าว')).toEqual([2, 4]);
    expect(segmenter.lineBreaks('ฉันกินข้าว').map((b) => b.offset)).toEqual([2, 4, 10]);
    lazy.release();
    expect(segmenter.opportunities('ฉันกินข้าว')).toEqual([]);
  });
});
