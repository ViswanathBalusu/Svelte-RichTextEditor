/**
 * Spike S10's two kernels (src/kernel/) behind one interface, in Node.js: on the pages-20
 * paragraphs they must break identically, every line must fit or be a single piece that cannot
 * break, lines must cover each paragraph without gap or overlap, and both must serve the S7
 * measurement interface consistently.
 */
import { corpusStamp, loadDocument } from '@docedit/corpus';
import { toFlow, type CdmEnvelopeLike, type FontKey } from '@docedit/layout';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fontManifest } from '../src/fonts.ts';
import { kernelParagraphs } from '../src/kernel/paragraphs.ts';
import { rustKernel } from '../src/kernel/rust-kernel.ts';
import { tsKernel } from '../src/kernel/ts-kernel.ts';
import type { KernelParagraph, TextKernel } from '../src/kernel/types.ts';
import { loadHarfbuzz } from '../src/shapers/harfbuzz.ts';
import { loadTextKernel } from '../src/shapers/harfrust.ts';

const pkg = resolve(import.meta.dirname, '..');
let ts: TextKernel;
let rust: TextKernel;
let paragraphs: KernelParagraph[];

beforeAll(async () => {
  ts = tsKernel((await loadHarfbuzz()).shaper);
  rust = rustKernel(
    (await loadTextKernel(new Uint8Array(readFileSync(join(pkg, 'wasm/bin/text-kernel.wasm')))))
      .module,
  );
  for (const f of fontManifest.fonts) {
    const bytes = new Uint8Array(readFileSync(join(pkg, 'fonts', f.file)));
    ts.loadFace(f.file, bytes);
    rust.loadFace(f.file, bytes);
  }
  paragraphs = kernelParagraphs(
    toFlow((await loadDocument('pages-20')).envelope as unknown as CdmEnvelopeLike),
  );
});

beforeEach(({ task }) => {
  task.meta.corpus = corpusStamp();
});

const serif: FontKey = { family: 'Noto Serif', sizePt: 11, bold: false, italic: false };

describe('text kernels', () => {
  it('break every pages-20 paragraph identically', () => {
    expect(paragraphs.length).toBeGreaterThan(400);
    for (const p of paragraphs) {
      const a = ts.breakParagraph(p);
      const b = rust.breakParagraph(p);
      expect(b.map((l) => [l.start, l.end])).toEqual(a.map((l) => [l.start, l.end]));
      for (let i = 0; i < a.length; i++)
        expect(Math.abs(a[i]!.widthPt - b[i]!.widthPt)).toBeLessThan(0.01);
    }
  });

  it('cover each paragraph and fit the width unless a piece cannot break', () => {
    for (const p of paragraphs) {
      const lines = rust.breakParagraph(p);
      expect(lines[0]!.start).toBe(0);
      expect(lines[lines.length - 1]!.end).toBe(p.text.length);
      for (let i = 1; i < lines.length; i++) expect(lines[i]!.start).toBe(lines[i - 1]!.end);
      for (const l of lines) {
        const pieceAlone = !/\s/.test(p.text.slice(l.start, l.end).trim());
        if (!pieceAlone) expect(l.widthPt).toBeLessThanOrEqual(p.widthPt + 1e-3);
      }
    }
  });

  it('hyphenates only when asked, and only in the Rust kernel', () => {
    const long = paragraphs.reduce((a, b) => (b.text.length > a.text.length ? b : a));
    expect(rust.breakParagraph(long).some((l) => l.hyphenated)).toBe(false);
    const hyphenated = rust.breakParagraph({ ...long, hyphenate: true });
    expect(hyphenated.some((l) => l.hyphenated)).toBe(true);
    expect(hyphenated.length).toBeLessThanOrEqual(rust.breakParagraph(long).length);
    expect(ts.breakParagraph({ ...long, hyphenate: true }).some((l) => l.hyphenated)).toBe(false);
  });

  it('serve the S7 measurement interface the same way', () => {
    for (const k of [ts, rust]) {
      const total = k.advance(serif, 'office');
      const per = k.advances!(serif, 'office');
      expect(per).toHaveLength(6);
      expect(per.reduce((s, x) => s + x, 0)).toBeCloseTo(total, 6);
      // The "ffi" ligature: its interior code units carry no advance.
      expect(per.filter((x) => x === 0).length).toBeGreaterThan(0);
      expect(k.lineMetrics(serif).ascent).toBeGreaterThan(0);
    }
    expect(rust.advance(serif, 'Toward AVATAR')).toBeCloseTo(ts.advance(serif, 'Toward AVATAR'), 6);
    expect(rust.lineMetrics(serif)).toEqual(ts.lineMetrics(serif));
  });
});
