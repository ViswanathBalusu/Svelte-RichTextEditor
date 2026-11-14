/**
 * S10 prototype 1: the shaper alone in WebAssembly (harfbuzzjs), with UAX #14 segmentation
 * (`linebreak` 1.1.0) and first-fit line breaking in TypeScript. Segment widths are cached in
 * JavaScript by face and text, so a re-break after a keystroke shapes only the changed pieces.
 */
import type { FontKey, LineMetrics } from '@docedit/layout';
import LineBreaker from 'linebreak';
import { resolveFace } from '../fonts.ts';
import type { Shaper } from '../shapers/types.ts';
import { firstFit, type Opportunity } from './first-fit.ts';
import { faceMetrics, type FaceMetrics } from './metrics.ts';
import type { KernelLine, KernelParagraph, KernelStats, TextKernel } from './types.ts';

function* opportunities(text: string): Generator<Opportunity> {
  const breaker = new LineBreaker(text);
  for (let b = breaker.nextBreak(); b; b = breaker.nextBreak())
    // `linebreak` does not mark the end of the text as mandatory; UAX #14 rule LB3 does.
    yield { at: b.position, mandatory: b.required || b.position === text.length };
}

export function tsKernel(
  shaper: Shaper,
  name = 'ts-kernel (harfbuzzjs 1.6.1, linebreak 1.1.0)',
): TextKernel {
  const metrics = new Map<string, FaceMetrics>();
  const cache = new Map<string, number>();
  let shaped = 0;
  let hits = 0;
  const units = (file: string, text: string): number => {
    const key = `${file}\u0000${text}`;
    const hit = cache.get(key);
    if (hit !== undefined) {
      hits++;
      return hit;
    }
    shaped++;
    const w = shaper.width(file, text);
    cache.set(key, w);
    return w;
  };
  const upem = (file: string): number => metrics.get(file)?.upem ?? shaper.upem(file);
  return {
    id: name,
    name,
    loadFace(file, bytes) {
      shaper.loadFont(file, bytes);
      metrics.set(file, faceMetrics(bytes));
    },
    advance(font: FontKey, text: string): number {
      const file = resolveFace(font).file;
      return (units(file, text) * font.sizePt) / upem(file);
    },
    advances(font: FontKey, text: string): number[] {
      const file = resolveFace(font).file;
      const scale = font.sizePt / upem(file);
      const out = new Array<number>(text.length).fill(0);
      for (const g of shaper.shape(file, text))
        out[g.cluster] = (out[g.cluster] ?? 0) + g.advance * scale;
      return out;
    },
    lineMetrics(font: FontKey): LineMetrics {
      const m = metrics.get(resolveFace(font).file)!;
      const s = font.sizePt / m.upem;
      return { ascent: m.ascender * s, descent: m.descender * s, lineGap: m.lineGap * s };
    },
    breakParagraph(p: KernelParagraph): KernelLine[] {
      const runs = p.runs.map((r) => {
        const file = resolveFace(r.font).file;
        return { start: r.start, end: r.end, file, scale: r.font.sizePt / upem(file) };
      });
      const width = (from: number, to: number): number => {
        let w = 0;
        for (const r of runs) {
          const a = Math.max(from, r.start);
          const b = Math.min(to, r.end);
          if (a < b) w += units(r.file, p.text.slice(a, b)) * r.scale;
        }
        return w;
      };
      return firstFit(p.text, opportunities(p.text), p.widthPt, width);
    },
    clearCache() {
      cache.clear();
      shaped = 0;
      hits = 0;
    },
    stats: (): KernelStats => ({ shaped, cacheHits: hits, cacheEntries: cache.size }),
    memoryBytes: () => shaper.memoryBytes(),
  };
}
