/**
 * Geometry for SVG uploads: path data (SVG 1.1 §8.3 grammar), basic shapes, transforms and
 * bounding boxes. Every path is reduced to absolute move, line, cubic and close commands; arcs
 * become cubic Béziers (SVG 1.1 F.6.5 endpoint to centre conversion), quadratic curves are raised
 * to cubics. As SVG requires, a path is drawn up to its first error.
 */

/** A 2D affine matrix [a b c d e f]: (x, y) → (a x + c y + e, b x + d y + f). */
export type Mat = readonly [number, number, number, number, number, number];

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

/** A × B: apply B first, then A. */
export function mul(A: Mat, B: Mat): Mat {
  return [
    A[0] * B[0] + A[2] * B[1],
    A[1] * B[0] + A[3] * B[1],
    A[0] * B[2] + A[2] * B[3],
    A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4],
    A[1] * B[4] + A[3] * B[5] + A[5],
  ];
}

export function apply(m: Mat, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function invertible(m: Mat): boolean {
  const det = m[0] * m[3] - m[1] * m[2];
  return Number.isFinite(det) && Math.abs(det) > 1e-12;
}

export type Seg =
  | { op: 'M'; x: number; y: number }
  | { op: 'L'; x: number; y: number }
  | { op: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { op: 'Z' };

const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;

/** A scanner over number lists (path data, points, transforms, view boxes). */
class Scanner {
  i = 0;
  readonly s: string;
  constructor(s: string) {
    this.s = s;
  }
  skip(): void {
    while (this.i < this.s.length && /[\s,]/.test(this.s[this.i]!)) this.i++;
  }
  skipSpace(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++;
  }
  done(): boolean {
    this.skip();
    return this.i >= this.s.length;
  }
  number(): number | null {
    this.skip();
    NUMBER.lastIndex = this.i;
    const m = NUMBER.exec(this.s);
    if (!m) return null;
    const v = Number(m[0]);
    if (!Number.isFinite(v) || Math.abs(v) > 1e9) return null;
    this.i += m[0].length;
    return v;
  }
  flag(): number | null {
    this.skip();
    const c = this.s[this.i];
    if (c !== '0' && c !== '1') return null;
    this.i++;
    return c === '1' ? 1 : 0;
  }
  peekNumber(): boolean {
    this.skip();
    return /[+\-.\d]/.test(this.s[this.i] ?? '');
  }
}

/** A list of numbers separated by white space or commas; null if anything else is there. */
export function numberList(text: string): number[] | null {
  const sc = new Scanner(text);
  const out: number[] = [];
  while (!sc.done()) {
    const v = sc.number();
    if (v === null) return null;
    out.push(v);
  }
  return out;
}

/** Arc to cubic Béziers (SVG 1.1 F.6.5, F.6.6). */
function arcToCubics(
  x1: number,
  y1: number,
  rxIn: number,
  ryIn: number,
  phiDeg: number,
  fa: number,
  fs: number,
  x2: number,
  y2: number,
  out: Seg[],
): void {
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if ((x1 === x2 && y1 === y2) || rx === 0 || ry === 0) {
    if (x1 !== x2 || y1 !== y2) out.push({ op: 'L', x: x2, y: y2 });
    return;
  }
  const phi = (phiDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let coef = den === 0 ? 0 : Math.sqrt(Math.max(0, num / den));
  if (fa === fs) coef = -coef;
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number): number => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!fs && delta > 0) delta -= 2 * Math.PI;
  else if (fs && delta < 0) delta += 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
  const step = delta / n;
  const k = (4 / 3) * Math.tan(step / 4);
  let t = theta1;
  for (let i = 0; i < n; i++) {
    const c1 = Math.cos(t);
    const s1 = Math.sin(t);
    const t2 = t + step;
    const c2 = Math.cos(t2);
    const s2 = Math.sin(t2);
    const p = (ex: number, ey: number): [number, number] => [
      cx + rx * ex * cos - ry * ey * sin,
      cy + rx * ex * sin + ry * ey * cos,
    ];
    const [ax, ay] = p(c1 - k * s1, s1 + k * c1);
    const [bx, by] = p(c2 + k * s2, s2 - k * c2);
    const [ex, ey] = i === n - 1 ? [x2, y2] : p(c2, s2);
    out.push({ op: 'C', x1: ax, y1: ay, x2: bx, y2: by, x: ex, y: ey });
    t = t2;
  }
}

/** Path data to absolute segments; stops at the first error, as SVG 1.1 F.2 asks. */
export function parsePathData(d: string): { segs: Seg[]; error: boolean } {
  const sc = new Scanner(d);
  const out: Seg[] = [];
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let lastCtrl: [number, number] | null = null;
  let lastQuad: [number, number] | null = null;
  let cmd = '';
  let first = true;
  const nums = (n: number): number[] | null => {
    const v: number[] = [];
    for (let k = 0; k < n; k++) {
      const x = sc.number();
      if (x === null) return null;
      v.push(x);
    }
    return v;
  };
  for (;;) {
    sc.skipSpace();
    if (sc.i >= d.length) return { segs: out, error: false };
    const c = d[sc.i]!;
    if (/[MmZzLlHhVvCcSsQqTtAa]/.test(c)) {
      cmd = c;
      sc.i++;
    } else if (!(cmd && sc.peekNumber())) return { segs: out, error: true };
    else if (cmd === 'M') cmd = 'L';
    else if (cmd === 'm') cmd = 'l';
    if (first && cmd !== 'M' && cmd !== 'm') return { segs: out, error: true };
    first = false;
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? cx : 0;
    const oy = rel ? cy : 0;
    const C = cmd.toUpperCase();
    let ctrl: [number, number] | null = null;
    let quad: [number, number] | null = null;
    switch (C) {
      case 'Z':
        out.push({ op: 'Z' });
        cx = sx;
        cy = sy;
        break;
      case 'M': {
        const v = nums(2);
        if (!v) return { segs: out, error: true };
        cx = ox + v[0]!;
        cy = oy + v[1]!;
        sx = cx;
        sy = cy;
        out.push({ op: 'M', x: cx, y: cy });
        break;
      }
      case 'L': {
        const v = nums(2);
        if (!v) return { segs: out, error: true };
        cx = ox + v[0]!;
        cy = oy + v[1]!;
        out.push({ op: 'L', x: cx, y: cy });
        break;
      }
      case 'H': {
        const v = nums(1);
        if (!v) return { segs: out, error: true };
        cx = ox + v[0]!;
        out.push({ op: 'L', x: cx, y: cy });
        break;
      }
      case 'V': {
        const v = nums(1);
        if (!v) return { segs: out, error: true };
        cy = oy + v[0]!;
        out.push({ op: 'L', x: cx, y: cy });
        break;
      }
      case 'C':
      case 'S': {
        let x1: number;
        let y1: number;
        if (C === 'C') {
          const v = nums(2);
          if (!v) return { segs: out, error: true };
          x1 = ox + v[0]!;
          y1 = oy + v[1]!;
        } else {
          x1 = lastCtrl ? 2 * cx - lastCtrl[0] : cx;
          y1 = lastCtrl ? 2 * cy - lastCtrl[1] : cy;
        }
        const rest = nums(4);
        if (!rest) return { segs: out, error: true };
        const x2 = ox + rest[0]!;
        const y2 = oy + rest[1]!;
        cx = ox + rest[2]!;
        cy = oy + rest[3]!;
        out.push({ op: 'C', x1, y1, x2, y2, x: cx, y: cy });
        ctrl = [x2, y2];
        break;
      }
      case 'Q':
      case 'T': {
        let qx: number;
        let qy: number;
        if (C === 'Q') {
          const v = nums(2);
          if (!v) return { segs: out, error: true };
          qx = ox + v[0]!;
          qy = oy + v[1]!;
        } else {
          qx = lastQuad ? 2 * cx - lastQuad[0] : cx;
          qy = lastQuad ? 2 * cy - lastQuad[1] : cy;
        }
        const v = nums(2);
        if (!v) return { segs: out, error: true };
        const x = ox + v[0]!;
        const y = oy + v[1]!;
        out.push({
          op: 'C',
          x1: cx + (2 / 3) * (qx - cx),
          y1: cy + (2 / 3) * (qy - cy),
          x2: x + (2 / 3) * (qx - x),
          y2: y + (2 / 3) * (qy - y),
          x,
          y,
        });
        cx = x;
        cy = y;
        quad = [qx, qy];
        break;
      }
      case 'A': {
        const r = nums(3);
        if (!r) return { segs: out, error: true };
        const fa = sc.flag();
        const fs = fa === null ? null : sc.flag();
        if (fa === null || fs === null) return { segs: out, error: true };
        const v = nums(2);
        if (!v) return { segs: out, error: true };
        const x = ox + v[0]!;
        const y = oy + v[1]!;
        arcToCubics(cx, cy, r[0]!, r[1]!, r[2]!, fa, fs, x, y, out);
        cx = x;
        cy = y;
        break;
      }
    }
    lastCtrl = ctrl;
    lastQuad = quad;
    if (C === 'Z' && sc.peekNumber()) return { segs: out, error: true };
  }
}

const KAPPA = 0.5522847498307936;

/** An ellipse as four cubic Béziers. */
export function ellipse(cx: number, cy: number, rx: number, ry: number): Seg[] {
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  return [
    { op: 'M', x: cx + rx, y: cy },
    { op: 'C', x1: cx + rx, y1: cy + ky, x2: cx + kx, y2: cy + ry, x: cx, y: cy + ry },
    { op: 'C', x1: cx - kx, y1: cy + ry, x2: cx - rx, y2: cy + ky, x: cx - rx, y: cy },
    { op: 'C', x1: cx - rx, y1: cy - ky, x2: cx - kx, y2: cy - ry, x: cx, y: cy - ry },
    { op: 'C', x1: cx + kx, y1: cy - ry, x2: cx + rx, y2: cy - ky, x: cx + rx, y: cy },
    { op: 'Z' },
  ];
}

/** A rectangle, with rounded corners when rx or ry is positive. */
export function rect(
  x: number,
  y: number,
  w: number,
  h: number,
  rxIn: number,
  ryIn: number,
): Seg[] {
  const rx = Math.min(Math.max(0, rxIn), w / 2);
  const ry = Math.min(Math.max(0, ryIn), h / 2);
  if (rx === 0 || ry === 0)
    return [
      { op: 'M', x, y },
      { op: 'L', x: x + w, y },
      { op: 'L', x: x + w, y: y + h },
      { op: 'L', x, y: y + h },
      { op: 'Z' },
    ];
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  return [
    { op: 'M', x: x + rx, y },
    { op: 'L', x: x + w - rx, y },
    { op: 'C', x1: x + w - rx + kx, y1: y, x2: x + w, y2: y + ry - ky, x: x + w, y: y + ry },
    { op: 'L', x: x + w, y: y + h - ry },
    {
      op: 'C',
      x1: x + w,
      y1: y + h - ry + ky,
      x2: x + w - rx + kx,
      y2: y + h,
      x: x + w - rx,
      y: y + h,
    },
    { op: 'L', x: x + rx, y: y + h },
    { op: 'C', x1: x + rx - kx, y1: y + h, x2: x, y2: y + h - ry + ky, x, y: y + h - ry },
    { op: 'L', x, y: y + ry },
    { op: 'C', x1: x, y1: y + ry - ky, x2: x + rx - kx, y2: y, x: x + rx, y },
    { op: 'Z' },
  ];
}

/** `points` of polyline and polygon; an odd trailing number is dropped (SVG 1.1 §9.7). */
export function polyline(points: string, close: boolean): Seg[] {
  const sc = new Scanner(points);
  const v: number[] = [];
  while (!sc.done()) {
    const n = sc.number();
    if (n === null) break;
    v.push(n);
  }
  const out: Seg[] = [];
  for (let i = 0; i + 1 < v.length; i += 2)
    out.push(i === 0 ? { op: 'M', x: v[i]!, y: v[i + 1]! } : { op: 'L', x: v[i]!, y: v[i + 1]! });
  if (close && out.length > 0) out.push({ op: 'Z' });
  return out;
}

/** The `transform` attribute (SVG 1.1 §7.6); null when invalid (the element is then not drawn). */
export function parseTransform(text: string): Mat | null {
  let m: Mat = IDENTITY;
  const re = /\s*(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^()]*)\)\s*,?/gy;
  let pos = 0;
  const s = text.trim();
  while (pos < s.length) {
    re.lastIndex = pos;
    const r = re.exec(s);
    if (!r) return null;
    pos = re.lastIndex;
    const a = numberList(r[2]!);
    if (!a) return null;
    let t: Mat;
    switch (r[1]) {
      case 'matrix':
        if (a.length !== 6) return null;
        t = [a[0]!, a[1]!, a[2]!, a[3]!, a[4]!, a[5]!];
        break;
      case 'translate':
        if (a.length !== 1 && a.length !== 2) return null;
        t = [1, 0, 0, 1, a[0]!, a[1] ?? 0];
        break;
      case 'scale':
        if (a.length !== 1 && a.length !== 2) return null;
        t = [a[0]!, 0, 0, a[1] ?? a[0]!, 0, 0];
        break;
      case 'rotate': {
        if (a.length !== 1 && a.length !== 3) return null;
        const r0 = (a[0]! * Math.PI) / 180;
        const rot: Mat = [Math.cos(r0), Math.sin(r0), -Math.sin(r0), Math.cos(r0), 0, 0];
        if (a.length === 3)
          t = mul(mul([1, 0, 0, 1, a[1]!, a[2]!], rot), [1, 0, 0, 1, -a[1]!, -a[2]!]);
        else t = rot;
        break;
      }
      case 'skewX':
        if (a.length !== 1) return null;
        t = [1, 0, Math.tan((a[0]! * Math.PI) / 180), 1, 0, 0];
        break;
      default:
        if (a.length !== 1) return null;
        t = [1, Math.tan((a[0]! * Math.PI) / 180), 0, 1, 0, 0];
    }
    m = mul(m, t);
  }
  return m.every(Number.isFinite) ? m : null;
}

/** Bounding box of segments in their own space, using the curves' real extrema. */
export function bbox(segs: readonly Seg[]): [number, number, number, number] | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = (x: number, y: number): void => {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  };
  let px = 0;
  let py = 0;
  let sx = 0;
  let sy = 0;
  const extrema = (p0: number, p1: number, p2: number, p3: number): number[] => {
    // Roots of the derivative of a cubic Bézier coordinate.
    const a = -p0 + 3 * p1 - 3 * p2 + p3;
    const b = 2 * (p0 - 2 * p1 + p2);
    const c = p1 - p0;
    const ts: number[] = [];
    if (Math.abs(a) < 1e-12) {
      if (Math.abs(b) > 1e-12) ts.push(-c / b);
    } else {
      const disc = b * b - 4 * a * c;
      if (disc >= 0) {
        const q = Math.sqrt(disc);
        ts.push((-b + q) / (2 * a), (-b - q) / (2 * a));
      }
    }
    return ts.filter((t) => t > 0 && t < 1);
  };
  const at = (t: number, p0: number, p1: number, p2: number, p3: number): number => {
    const u = 1 - t;
    return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
  };
  for (const s of segs) {
    if (s.op === 'M') {
      px = sx = s.x;
      py = sy = s.y;
      add(px, py);
    } else if (s.op === 'L') {
      px = s.x;
      py = s.y;
      add(px, py);
    } else if (s.op === 'C') {
      add(s.x, s.y);
      for (const t of extrema(px, s.x1, s.x2, s.x))
        add(at(t, px, s.x1, s.x2, s.x), at(t, py, s.y1, s.y2, s.y));
      for (const t of extrema(py, s.y1, s.y2, s.y))
        add(at(t, px, s.x1, s.x2, s.x), at(t, py, s.y1, s.y2, s.y));
      px = s.x;
      py = s.y;
    } else {
      px = sx;
      py = sy;
    }
  }
  return Number.isFinite(x0) ? [x0, y0, x1, y1] : null;
}

/** Segments with every point mapped through `m`. */
export function transformSegs(segs: readonly Seg[], m: Mat): Seg[] {
  return segs.map((s) => {
    if (s.op === 'Z') return s;
    if (s.op === 'C') {
      const [x1, y1] = apply(m, s.x1, s.y1);
      const [x2, y2] = apply(m, s.x2, s.y2);
      const [x, y] = apply(m, s.x, s.y);
      return { op: 'C', x1, y1, x2, y2, x, y };
    }
    const [x, y] = apply(m, s.x, s.y);
    return { op: s.op, x, y };
  });
}

/** The transform that maps a view box onto a viewport (SVG 1.1 §7.8). */
export function viewBoxTransform(
  vb: readonly [number, number, number, number],
  width: number,
  height: number,
  par: string | undefined,
): Mat {
  const [minX, minY, vbW, vbH] = vb;
  const parts = (par ?? '').trim().split(/\s+/);
  const align = parts[0] === 'defer' ? (parts[1] ?? 'xMidYMid') : parts[0] || 'xMidYMid';
  const slice = (parts[0] === 'defer' ? parts[2] : parts[1]) === 'slice';
  const sx = width / vbW;
  const sy = height / vbH;
  if (align === 'none') return [sx, 0, 0, sy, -minX * sx, -minY * sy];
  const s = slice ? Math.max(sx, sy) : Math.min(sx, sy);
  const xAlign = /xMid/.test(align) ? 0.5 : /xMax/.test(align) ? 1 : 0;
  const yAlign = /YMid/.test(align) ? 0.5 : /YMax/.test(align) ? 1 : 0;
  const tx = (width - vbW * s) * xAlign - minX * s;
  const ty = (height - vbH * s) * yAlign - minY * s;
  return [s, 0, 0, s, tx, ty];
}

export function parseViewBox(text: string | undefined): [number, number, number, number] | null {
  if (text === undefined) return null;
  const v = numberList(text);
  if (!v || v.length !== 4 || !(v[2]! > 0) || !(v[3]! > 0)) return null;
  return [v[0]!, v[1]!, v[2]!, v[3]!];
}
