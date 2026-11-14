/**
 * Writes a drawing (svg-draw.ts) as a new SVG file for display and as a PDF file for the
 * typesetter (BE-043 criterion 5; 09 §2: "SVG is converted to PDF when the asset is processed").
 * Neither output copies any text of the upload: every element, attribute and identifier is
 * generated here, and every value is a number or a generated name. The PDF is deterministic: the
 * same drawing always gives the same bytes.
 */
import { deflateSync } from 'node:zlib';
import type { Clip, Drawing, Gradient, GradientStop, Paint, Shape } from './svg-draw.ts';
import { mul, type Mat, type Seg } from './svg-path.ts';

/** A number with at most four decimals, no exponent, no trailing zeros. */
export function num(v: number): string {
  if (!Number.isFinite(v)) return '0';
  const r = Math.round(v * 10000) / 10000;
  if (Object.is(r, -0) || r === 0) return '0';
  let s = r.toFixed(4);
  s = s.replace(/\.?0+$/, '');
  return s;
}

const hex2 = (n: number): string =>
  Math.max(0, Math.min(255, Math.round(n)))
    .toString(16)
    .padStart(2, '0');
const hex = (p: { r: number; g: number; b: number }): string =>
  `#${hex2(p.r)}${hex2(p.g)}${hex2(p.b)}`;

function pathData(segs: readonly Seg[]): string {
  const out: string[] = [];
  for (const s of segs) {
    if (s.op === 'Z') out.push('Z');
    else if (s.op === 'C')
      out.push(`C${num(s.x1)} ${num(s.y1)} ${num(s.x2)} ${num(s.y2)} ${num(s.x)} ${num(s.y)}`);
    else out.push(`${s.op}${num(s.x)} ${num(s.y)}`);
  }
  return out.join('');
}

const matrix = (m: Mat): string => `matrix(${m.map(num).join(' ')})`;

/** The display rendition: an SVG made only of paths, gradients and clip paths. */
export function writeSvg(d: Drawing): string {
  const defs: string[] = [];
  const body: string[] = [];
  let gid = 0;
  let cid = 0;
  const clipIds = new Map<Clip, string>();
  const paintAttr = (p: Paint | null): string => {
    if (!p) return 'none';
    if (p.kind === 'rgb') return hex(p.rgb);
    const id = `g${gid++}`;
    const g = p.gradient;
    const stops = g.stops
      .map((s) => `<stop offset="${num(s.offset)}" stop-color="${hex(s.rgb)}"/>`)
      .join('');
    const c = g.coords.map(num);
    defs.push(
      g.type === 'linear'
        ? `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${c[0]}" y1="${c[1]}" x2="${c[2]}" y2="${c[3]}" gradientTransform="${matrix(g.matrix)}">${stops}</linearGradient>`
        : `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" fx="${c[0]}" fy="${c[1]}" fr="${c[2]}" cx="${c[3]}" cy="${c[4]}" r="${c[5]}" gradientTransform="${matrix(g.matrix)}">${stops}</radialGradient>`,
    );
    return `url(#${id})`;
  };
  for (const s of d.shapes) {
    const attrs: string[] = [`d="${pathData(s.segs)}"`, `transform="${matrix(s.ctm)}"`];
    attrs.push(`fill="${paintAttr(s.fill)}"`);
    if (s.fill) {
      if (s.fillOpacity < 1) attrs.push(`fill-opacity="${num(s.fillOpacity)}"`);
      if (s.fillRule === 'evenodd') attrs.push('fill-rule="evenodd"');
    }
    if (s.stroke) {
      attrs.push(`stroke="${paintAttr(s.stroke)}"`, `stroke-width="${num(s.strokeWidth)}"`);
      if (s.strokeOpacity < 1) attrs.push(`stroke-opacity="${num(s.strokeOpacity)}"`);
      if (s.lineCap !== 'butt') attrs.push(`stroke-linecap="${s.lineCap}"`);
      if (s.lineJoin !== 'miter') attrs.push(`stroke-linejoin="${s.lineJoin}"`);
      if (s.miterLimit !== 4) attrs.push(`stroke-miterlimit="${num(s.miterLimit)}"`);
      if (s.dash)
        attrs.push(
          `stroke-dasharray="${s.dash.map(num).join(' ')}"`,
          `stroke-dashoffset="${num(s.dashOffset)}"`,
        );
    }
    let el = `<path ${attrs.join(' ')}/>`;
    for (const c of [...s.clips].reverse()) {
      let id = clipIds.get(c);
      if (!id) {
        id = `c${cid++}`;
        clipIds.set(c, id);
        defs.push(
          `<clipPath id="${id}" clipPathUnits="userSpaceOnUse"><path d="${pathData(c.segs)}"${c.rule === 'evenodd' ? ' clip-rule="evenodd"' : ''}/></clipPath>`,
        );
      }
      el = `<g clip-path="url(#${id})">${el}</g>`;
    }
    body.push(el);
  }
  const w = num(d.width);
  const h = num(d.height);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    (defs.length ? `<defs>${defs.join('')}</defs>` : '') +
    body.join('') +
    '</svg>\n'
  );
}

// --- PDF -----------------------------------------------------------------------------------------

/** CSS pixels (96 per inch) to PDF points (72 per inch). */
const PX = 0.75;

function pdfPath(segs: readonly Seg[]): string {
  const out: string[] = [];
  for (const s of segs) {
    if (s.op === 'Z') out.push('h');
    else if (s.op === 'M') out.push(`${num(s.x)} ${num(s.y)} m`);
    else if (s.op === 'L') out.push(`${num(s.x)} ${num(s.y)} l`);
    else out.push(`${num(s.x1)} ${num(s.y1)} ${num(s.x2)} ${num(s.y2)} ${num(s.x)} ${num(s.y)} c`);
  }
  return out.join('\n');
}

const rgb01 = (s: { r: number; g: number; b: number }): string =>
  `${num(s.r / 255)} ${num(s.g / 255)} ${num(s.b / 255)}`;

/** Stops padded to cover 0 to 1, duplicates at the ends removed (PDF stitching functions). */
function normaliseStops(stops: readonly GradientStop[]): GradientStop[] {
  const s = [...stops];
  if (s[0]!.offset > 0) s.unshift({ ...s[0]!, offset: 0 });
  if (s[s.length - 1]!.offset < 1) s.push({ ...s[s.length - 1]!, offset: 1 });
  while (s.length > 2 && s[1]!.offset <= 0) s.shift();
  while (s.length > 2 && s[s.length - 2]!.offset >= 1) s.pop();
  return s;
}

function shadingFunction(stops: readonly GradientStop[]): string {
  const s = normaliseStops(stops);
  const fn = (a: GradientStop, b: GradientStop): string =>
    `<< /FunctionType 2 /Domain [0 1] /C0 [${rgb01(a.rgb)}] /C1 [${rgb01(b.rgb)}] /N 1 >>`;
  if (s.length === 2) return fn(s[0]!, s[1]!);
  const fns: string[] = [];
  const bounds: string[] = [];
  const encode: string[] = [];
  for (let i = 0; i + 1 < s.length; i++) {
    fns.push(fn(s[i]!, s[i + 1]!));
    encode.push('0 1');
    if (i > 0) bounds.push(num(s[i]!.offset));
  }
  return `<< /FunctionType 3 /Domain [0 1] /Functions [${fns.join(' ')}] /Bounds [${bounds.join(' ')}] /Encode [${encode.join(' ')}] >>`;
}

/** The print rendition: a one-page PDF 1.4 of the drawing, at 96 CSS pixels per inch. */
export function writePdf(d: Drawing): Uint8Array {
  const W = d.width * PX;
  const H = d.height * PX;
  // The page's base transform: CSS pixels with the origin at the top left.
  const base: Mat = [PX, 0, 0, -PX, 0, H];
  const objects: string[] = [];
  const add = (body: string): number => {
    objects.push(body);
    return objects.length + 4; // objects 1 to 4 are fixed (see below)
  };
  const states = new Map<string, string>();
  const patterns: string[] = [];
  const state = (fill: number, stroke: number): string => {
    const key = `${num(fill)} ${num(stroke)}`;
    let name = states.get(key);
    if (!name) {
      name = `G${states.size}`;
      states.set(key, name);
    }
    return name;
  };
  const pattern = (g: Gradient, ctm: Mat): string => {
    const name = `P${patterns.length}`;
    const m = mul(mul(base, ctm), g.matrix);
    const c = g.coords.map(num).join(' ');
    const shading =
      g.type === 'linear'
        ? `<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [${c}] /Function ${shadingFunction(g.stops)} /Extend [true true] >>`
        : `<< /ShadingType 3 /ColorSpace /DeviceRGB /Coords [${c}] /Function ${shadingFunction(g.stops)} /Extend [true true] >>`;
    patterns.push(
      `/${name} ${add(`<< /Type /Pattern /PatternType 2 /Matrix [${m.map(num).join(' ')}] /Shading ${shading} >>`)} 0 R`,
    );
    return name;
  };
  const ops: string[] = [`${base.map(num).join(' ')} cm`];
  const draw = (s: Shape): void => {
    ops.push('q');
    for (const c of s.clips) ops.push(pdfPath(c.segs), c.rule === 'evenodd' ? 'W* n' : 'W n');
    const doFill = s.fill !== null && s.fillOpacity > 0;
    const doStroke = s.stroke !== null && s.strokeOpacity > 0 && s.strokeWidth > 0;
    if (!doFill && !doStroke) {
      ops.push('Q');
      return;
    }
    if ((doFill && s.fillOpacity < 1) || (doStroke && s.strokeOpacity < 1))
      ops.push(`/${state(doFill ? s.fillOpacity : 1, doStroke ? s.strokeOpacity : 1)} gs`);
    if (doFill) {
      if (s.fill!.kind === 'rgb') ops.push(`${rgb01(s.fill!.rgb)} rg`);
      else ops.push(`/Pattern cs /${pattern(s.fill!.gradient, s.ctm)} scn`);
    }
    if (doStroke) {
      if (s.stroke!.kind === 'rgb') ops.push(`${rgb01(s.stroke!.rgb)} RG`);
      else ops.push(`/Pattern CS /${pattern(s.stroke!.gradient, s.ctm)} SCN`);
      ops.push(
        `${num(s.strokeWidth)} w`,
        `${s.lineCap === 'butt' ? 0 : s.lineCap === 'round' ? 1 : 2} J`,
        `${s.lineJoin === 'miter' ? 0 : s.lineJoin === 'round' ? 1 : 2} j`,
        `${num(s.miterLimit)} M`,
      );
      if (s.dash) ops.push(`[${s.dash.map(num).join(' ')}] ${num(s.dashOffset)} d`);
    }
    ops.push(`${s.ctm.map(num).join(' ')} cm`, pdfPath(s.segs));
    const evenodd = s.fillRule === 'evenodd';
    ops.push(doFill && doStroke ? (evenodd ? 'B*' : 'B') : doFill ? (evenodd ? 'f*' : 'f') : 'S');
    ops.push('Q');
  };
  for (const s of d.shapes) draw(s);
  const content = deflateSync(Buffer.from(ops.join('\n'), 'latin1'), { level: 9 });
  const gs = [...states].map(([key, name]) => {
    const [f, st] = key.split(' ');
    return `/${name} ${add(`<< /Type /ExtGState /ca ${f} /CA ${st} >>`)} 0 R`;
  });
  const resources = `<< ${gs.length ? `/ExtGState << ${gs.join(' ')} >> ` : ''}${patterns.length ? `/Pattern << ${patterns.join(' ')} >> ` : ''}>>`;
  const fixed = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(W)} ${num(H)}] /Resources ${resources} /Contents 4 0 R >>`,
  ];
  // Assemble: header, objects 1 to 3, the content stream (4), the rest, cross-reference table.
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let size = 0;
  const push = (b: Uint8Array): void => {
    chunks.push(b);
    size += b.length;
  };
  const text = (s: string): void => push(Buffer.from(s, 'latin1'));
  text('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  fixed.forEach((body, i) => {
    offsets.push(size);
    text(`${i + 1} 0 obj\n${body}\nendobj\n`);
  });
  offsets.push(size);
  text(`4 0 obj\n<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`);
  push(content);
  text('\nendstream\nendobj\n');
  objects.forEach((body, i) => {
    offsets.push(size);
    text(`${i + 5} 0 obj\n${body}\nendobj\n`);
  });
  const xref = size;
  const count = offsets.length + 1;
  text(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (const o of offsets) text(`${String(o).padStart(10, '0')} 00000 n \n`);
  text(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(size);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}
