/**
 * The non-stroking colours a PDF's page content sets (`r g b rg`), for the checks of EXP-083
 * criterion 1 (lane V-EXP-081-096). Pure: it inflates every FlateDecode stream of the file with
 * node:zlib and reads the operators; no PDF tool is needed. A colour that is set in a stream
 * that cannot be inflated is not seen, so a missing colour is a failure, not a pass.
 */
import { inflateSync } from 'node:zlib';

export type Rgb = readonly [number, number, number];

/** The colours of a hex string such as `#1F5FAD`, as fractions in 0..1. */
export function hexToRgb(hex: string): Rgb {
  const h = hex.replace(/^#/, '');
  const part = (i: number): number => parseInt(h.slice(i, i + 2), 16) / 255;
  return [part(0), part(2), part(4)] as const;
}

/** Every stream of the file, inflated where it is FlateDecode, as latin1 text. */
function inflatedStreams(pdf: Uint8Array): string[] {
  const text = Buffer.from(pdf).toString('latin1');
  const out: string[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = m.index + m[0].length;
    const end = text.indexOf('endstream', start);
    if (end < 0) break;
    const dictStart = text.lastIndexOf('obj', m.index);
    const dict = text.slice(dictStart < 0 ? 0 : dictStart, m.index);
    const raw = Buffer.from(text.slice(start, end), 'latin1');
    if (/FlateDecode/.test(dict)) {
      try {
        out.push(inflateSync(raw).toString('latin1'));
      } catch {
        // Not a complete zlib stream: skipped.
      }
    } else {
      out.push(raw.toString('latin1'));
    }
    re.lastIndex = end;
  }
  return out;
}

/** The fill colours (`rg` operators) set in the file, in the order they occur. */
export function fillColours(pdf: Uint8Array): Rgb[] {
  const found: Rgb[] = [];
  const op = /(\d*\.?\d+)\s+(\d*\.?\d+)\s+(\d*\.?\d+)\s+rg\b/g;
  for (const s of inflatedStreams(pdf)) {
    let m: RegExpExecArray | null;
    while ((m = op.exec(s)) !== null)
      found.push([Number(m[1]), Number(m[2]), Number(m[3])] as const);
  }
  return found;
}

/** True when some fill colour is within `tol` of `want` on every channel. */
export function hasFillColour(colours: readonly Rgb[], want: Rgb, tol = 0.002): boolean {
  return colours.some((c) => c.every((v, i) => Math.abs(v - want[i]!) <= tol));
}
