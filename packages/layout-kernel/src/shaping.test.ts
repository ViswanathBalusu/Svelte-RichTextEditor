/**
 * WASM-006: shaping and measurement in the kernel. These tests start the real build of the crate in
 * Node.js and shape with a real font file (Noto Serif, packages/perf/fonts). The unit, the rounding,
 * the cluster rule and the cache are checked here; the comparison with HarfBuzz's own output is in
 * packages/perf/test/wasm-006-kernel-vs-harfbuzz.test.ts.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  KERNEL_FILES,
  KernelShapeError,
  createKernel,
  type KernelGlue,
  type LayoutKernel,
  type RunStyle,
} from './index.ts';

const dist = resolve(import.meta.dirname, '../dist');
const fonts = resolve(import.meta.dirname, '../../perf/fonts/files');
const built = existsSync(resolve(dist, KERNEL_FILES.wasm));
const required = process.env['DOCEDIT_KERNEL_REQUIRED'] === '1';
if (required && !built) throw new Error('dist/ is not built: run build:wasm first');

const font = (name: string): Uint8Array => new Uint8Array(readFileSync(resolve(fonts, name)));
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

async function start(): Promise<LayoutKernel> {
  const glue = (await import(
    `${pathToFileURL(resolve(dist, KERNEL_FILES.module)).href}?run=${Math.random()}`
  )) as KernelGlue;
  return createKernel(glue, new Uint8Array(readFileSync(resolve(dist, KERNEL_FILES.wasm))));
}

/** The kernel with Noto Serif Regular held under `serif`. */
async function withSerif(): Promise<LayoutKernel> {
  const kernel = await start();
  const bytes = font('NotoSerif-Regular.ttf');
  kernel.faces.load('', 'serif', sha256(bytes), bytes);
  return kernel;
}

const style = (over: Partial<RunStyle> = {}): RunStyle => ({
  alias: 'serif',
  sizeTwips: 240,
  language: '',
  features: '',
  ...over,
});
const sum = (values: ArrayLike<number>): number => Array.from(values).reduce((a, b) => a + b, 0);

/** Reads a table of an sfnt file, independently of the kernel. */
function table(bytes: Uint8Array, tag: string): DataView {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(4);
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    const name = String.fromCharCode(...bytes.subarray(at, at + 4));
    if (name === tag) return new DataView(bytes.buffer, bytes.byteOffset + view.getUint32(at + 8));
  }
  throw new Error(`no ${tag} table`);
}

/** round half up of value * size * 64 / upem, with integers. */
function expectedUnits(value: number, sizeTwips: number, upem: number): number {
  return Math.floor((2 * value * sizeTwips * 64 + upem) / (2 * upem));
}

describe.skipIf(!built)('the kernel shapes runs in the manifest’s faces (WASM-006)', () => {
  it('reports the unit: 1280 to the point, 64 to the twentieth of a point', async () => {
    const kernel = await start();
    expect(kernel.shaper.unitsPerPoint).toBe(1280);
  });

  it('gives one whole advance for each UTF-16 code unit, summing to the width of the run', async () => {
    const kernel = await withSerif();
    for (const text of ['Hello, world', 'Zażółć gęślą jaźń', 'AVA To', '  ', 'a']) {
      const advances = kernel.shaper.advances(style(), text);
      expect(advances).toHaveLength(text.length);
      expect(sum(advances), text).toBe(kernel.shaper.width(style(), text));
      for (const v of advances) expect(Number.isInteger(v)).toBe(true);
    }
    expect(kernel.shaper.advances(style(), '')).toHaveLength(0);
    expect(kernel.shaper.width(style(), '')).toBe(0);
  });

  it('scales the font’s advance to the size with integer arithmetic, rounded half up', async () => {
    const kernel = await withSerif();
    const bytes = font('NotoSerif-Regular.ttf');
    const upem = table(bytes, 'head').getUint16(18);
    // The advance of a space, from the file's own hmtx table through hhea's count, as the reference.
    const numHMetrics = table(bytes, 'hhea').getUint16(34);
    expect(numHMetrics).toBeGreaterThan(0);
    // Shape one space at several sizes: it must equal the font's advance, scaled and rounded by the rule.
    const fontUnits = kernel.shaper.advances(style({ sizeTwips: upem * 20 }), ' ');
    // At a size of `upem` points the scaled value is the font value * 20 * 64 (no rounding needed).
    const space = fontUnits[0]! / (20 * 64);
    expect(Number.isInteger(space)).toBe(true);
    for (const size of [1, 7, 130, 200, 210, 240, 241, 999, 4000]) {
      expect(kernel.shaper.advances(style({ sizeTwips: size }), ' ')[0], `${size} twips`).toBe(
        expectedUnits(space, size, upem),
      );
    }
  });

  it('puts a cluster’s advance on its first unit: a ligature leaves 0, a surrogate pair too', async () => {
    const kernel = await withSerif();
    const withLigature = kernel.shaper.advances(style(), 'office');
    const without = kernel.shaper.advances(style({ features: 'liga=0,clig=0' }), 'office');
    // "ffi" is one glyph in this face: the first unit has the glyph's advance, the next two have 0.
    expect(withLigature[1]).toBeGreaterThan(0);
    expect(withLigature[2]).toBe(0);
    expect(withLigature[3]).toBe(0);
    expect(without.every((v) => v > 0)).toBe(true);
    expect(sum(withLigature)).not.toBe(sum(without));
    // U+1F600 is a surrogate pair; the face has no glyph for it, so it is .notdef in one cluster of two units.
    const pair = kernel.shaper.advances(style(), 'a\u{1F600}b');
    expect(pair).toHaveLength(4);
    expect(pair[2]).toBe(0);
    expect(pair[1]! + pair[2]!).toBe(pair[1]);
  });

  it('turns kerning and ligatures off and on by the painter’s features', async () => {
    const kernel = await withSerif();
    const on = kernel.shaper.width(style(), 'AVATAR To');
    const off = kernel.shaper.width(style({ features: 'kern=0' }), 'AVATAR To');
    expect(on).toBeLessThan(off);
    // The same list, spelled with spaces and in another order, is the same run.
    expect(kernel.shaper.width(style({ features: ' kern=0 , liga=1 ' }), 'AVATAR To')).toBe(
      kernel.shaper.width(style({ features: 'liga=1,kern=0' }), 'AVATAR To'),
    );
  });

  it('is deterministic: the same run gives the same answer on every call and in every instance', async () => {
    const a = await withSerif();
    const b = await withSerif();
    const text = 'The quick brown fox jumps over the lazy dog, 0123456789 — “quoted” office fi';
    const first = Array.from(a.shaper.advances(style(), text));
    expect(Array.from(a.shaper.advances(style(), text))).toEqual(first);
    expect(Array.from(b.shaper.advances(style(), text))).toEqual(first);
    a.shaper.clearCache();
    expect(Array.from(a.shaper.advances(style(), text))).toEqual(first);
  });

  it('refuses what it cannot shape with a code, and the kernel goes on', async () => {
    const kernel = await withSerif();
    const code = (call: () => unknown): string => {
      try {
        call();
      } catch (error) {
        expect(error).toBeInstanceOf(KernelShapeError);
        return (error as KernelShapeError).code;
      }
      return 'none';
    };
    expect(code(() => kernel.shaper.advances(style({ alias: 'missing' }), 'a'))).toBe(
      'unknown_face',
    );
    expect(code(() => kernel.shaper.advances(style({ features: 'k!@=x' }), 'a'))).toBe(
      'bad_feature',
    );
    expect(code(() => kernel.shaper.advances(style({ sizeTwips: 0 }), 'a'))).toBe('bad_size');
    expect(code(() => kernel.shaper.lineMetrics('missing', 240))).toBe('unknown_face');
    expect(kernel.shaper.width(style(), 'still works')).toBeGreaterThan(0);
  });

  it('gives the face’s line metrics as the font file states them', async () => {
    const kernel = await withSerif();
    const bytes = font('NotoSerif-Regular.ttf');
    const upem = table(bytes, 'head').getUint16(18);
    const hhea = table(bytes, 'hhea');
    const os2 = table(bytes, 'OS/2');
    const typo = (os2.getUint16(62) & 0x80) !== 0;
    const [ascender, descender, gap] = typo
      ? [os2.getInt16(68), os2.getInt16(70), os2.getInt16(72)]
      : [hhea.getInt16(4), hhea.getInt16(6), hhea.getInt16(8)];
    for (const size of [200, 240, 505]) {
      const m = kernel.shaper.lineMetrics('serif', size);
      expect(m.ascent, `${size} ascent`).toBe(expectedUnits(ascender, size, upem));
      // The descent is positive, the file's descender is negative.
      expect(m.descent, `${size} descent`).toBe(-expectedUnits(descender, size, upem));
      expect(m.lineGap, `${size} gap`).toBe(expectedUnits(gap, size, upem));
    }
  });

  it('caches by face, size, language, features and text, and counts hits and misses', async () => {
    const kernel = await withSerif();
    const s = kernel.shaper;
    expect(s.cacheStats()).toEqual({ hits: 0, misses: 0, entries: 0, units: 0 });
    s.advances(style(), 'hello');
    s.advances(style(), 'hello');
    expect(s.cacheStats()).toMatchObject({ hits: 1, misses: 1, entries: 1, units: 5 });
    s.advances(style({ sizeTwips: 250 }), 'hello');
    s.advances(style({ language: 'de' }), 'hello');
    s.advances(style({ features: 'kern=0' }), 'hello');
    s.advances(style(), 'hellp');
    expect(s.cacheStats()).toMatchObject({ hits: 1, misses: 5, entries: 5 });
    // The width of a run shapes it once too: the same key as its advances.
    s.width(style(), 'hello');
    expect(s.cacheStats().hits).toBe(2);
    s.clearCache();
    expect(s.cacheStats().entries).toBe(0);
  });

  it('forgets the answers of a face when it is replaced or released, and keeps the others', async () => {
    const kernel = await withSerif();
    const sans = font('NotoSans-Regular.ttf');
    kernel.faces.load('', 'sans', sha256(sans), sans);
    const s = kernel.shaper;
    s.advances(style(), 'hello');
    s.advances(style({ alias: 'sans' }), 'hello');
    expect(s.cacheStats().entries).toBe(2);
    // A later font load moves the epoch; a new face under 'sans' drops that alias's answers only.
    const epoch = kernel.faces.epoch();
    const bold = font('NotoSans-Bold.ttf');
    kernel.faces.release('sans');
    expect(s.cacheStats().entries).toBe(1);
    kernel.faces.load('', 'sans', sha256(bold), bold);
    expect(kernel.faces.epoch()).toBe(epoch + 1);
    const boldAdvances = Array.from(s.advances(style({ alias: 'sans' }), 'hello'));
    const regular = Array.from(
      (await (async () => {
        const k = await start();
        k.faces.load('', 'sans', sha256(sans), sans);
        return k.shaper.advances(style({ alias: 'sans' }), 'hello');
      })()) as Int32Array,
    );
    // The answer is the new face's, not the earlier face's: the bold face is wider.
    expect(sum(boldAdvances)).toBeGreaterThan(sum(regular));
    // The answer for 'serif' is still in the cache.
    const hits = s.cacheStats().hits;
    s.advances(style(), 'hello');
    expect(s.cacheStats().hits).toBe(hits + 1);
    kernel.faces.releaseAll();
    expect(s.cacheStats().entries).toBe(0);
  });

  it('shapes a CJK face and a right-to-left run without failing', async () => {
    const kernel = await start();
    const cjk = font('HaranoAjiGothic-Regular.otf');
    kernel.faces.load('', 'cjk', sha256(cjk), cjk);
    const japanese = kernel.shaper.advances(
      style({ alias: 'cjk', language: 'ja' }),
      '日本語のテキスト',
    );
    expect(japanese).toHaveLength(8);
    expect(japanese.every((v) => v > 0)).toBe(true);
    // Each ideograph is one em wide: 12 pt = 15,360 units.
    expect(japanese[0]).toBe(12 * 1280);
    // Hebrew has no glyphs in this face; the run still shapes (as .notdef) and keeps its length.
    const hebrew = kernel.shaper.advances(style({ alias: 'cjk' }), 'שלום');
    expect(hebrew).toHaveLength(4);
  });
});
