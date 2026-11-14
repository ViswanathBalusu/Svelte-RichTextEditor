/**
 * Shared measurement code of spike S5 (SPK-018), run in every browser page and in Node.js, so
 * that the shaper results compared across environments come from the same code.
 */
import { sha256Hex } from '@docedit/model';
import type { SampleLine } from './lines.ts';
import { glyphKey, NO_KERN, NO_LIGA, type Shaper } from './shapers/types.ts';
import { summarise } from './stats.ts';
import { now } from './wasm.ts';

export interface ShapedLines {
  /** Line widths in CSS pixels: default features, and kerning and ligatures off. */
  widths: { default: number[]; noKernLiga: number[] };
  /** SHA-256 of every segment's glyphs, clusters, advances and offsets, in line order. */
  digest: string;
  ms: number;
  /** Glyphs that are `.notdef` (0): characters the face does not have. */
  notdef: number;
}

export async function shapeLines(
  shaper: Shaper,
  lines: readonly SampleLine[],
): Promise<ShapedLines> {
  const def: number[] = [];
  const plain: number[] = [];
  const keys: string[] = [];
  let notdef = 0;
  const t0 = now();
  for (const line of lines) {
    let w = 0;
    let p = 0;
    for (const s of line.segments) {
      const scale = s.sizePx / shaper.upem(s.face);
      const glyphs = shaper.shape(s.face, s.text);
      for (const g of glyphs) {
        w += g.advance * scale;
        if (g.glyph === 0) notdef++;
      }
      keys.push(glyphKey(glyphs));
      for (const g of shaper.shape(s.face, s.text, NO_KERN | NO_LIGA)) p += g.advance * scale;
    }
    def.push(w);
    plain.push(p);
  }
  const ms = now() - t0;
  return {
    widths: { default: def, noKernLiga: plain },
    digest: await sha256Hex(keys.join('\n')),
    ms,
    notdef,
  };
}

/** Lines in which every segment's characters are in its face. */
export function coveredLines(
  shaper: Shaper,
  lines: readonly SampleLine[],
): { kept: SampleLine[]; dropped: SampleLine[] } {
  const kept: SampleLine[] = [];
  const dropped: SampleLine[] = [];
  for (const l of lines) {
    const ok = l.segments.every((s) => shaper.shape(s.face, s.text).every((g) => g.glyph !== 0));
    (ok ? kept : dropped).push(l);
  }
  return { kept, dropped };
}

export interface DifferenceStats {
  n: number;
  /** Median, 95th percentile and maximum of the absolute difference, in CSS pixels. */
  medianAbs: number;
  p95Abs: number;
  maxAbs: number;
  /** Mean of the signed difference (a − b). */
  meanSigned: number;
  /** Share of lines whose absolute difference is at most 0.5 px (02 §9.3). */
  withinHalfPx: number;
  /** Lines over 0.5 px. */
  overHalfPx: number;
}

export function differences(a: readonly number[], b: readonly number[]): DifferenceStats {
  const d = a.map((v, i) => v - b[i]!);
  const abs = summarise(d.map(Math.abs));
  const over = d.filter((x) => Math.abs(x) > 0.5).length;
  return {
    n: d.length,
    medianAbs: abs.median,
    p95Abs: abs.p95,
    maxAbs: abs.max,
    meanSigned: d.length ? d.reduce((s, x) => s + x, 0) / d.length : Number.NaN,
    withinHalfPx: d.length ? (d.length - over) / d.length : Number.NaN,
    overHalfPx: over,
  };
}
