/**
 * Styles of SVG uploads: colours, lengths, the presentation properties the converter draws, and a
 * small subset of CSS (`tag`, `.class` and `#id` selectors, alone or compounded, in `style`
 * elements; `style` attributes). Anything else in a style sheet is ignored, except what could
 * fetch or run something (`@import`, `url()` to another document, `expression(`), which fails the
 * upload as unsafe.
 */
import { AssetError } from './errors.ts';

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export type PaintSpec =
  | { kind: 'none' }
  | { kind: 'current' }
  | { kind: 'color'; rgb: Rgb; alpha: number }
  | { kind: 'url'; id: string; fallback: PaintSpec | null };

/** The properties the converter supports; values are the raw CSS text. */
export const PROPERTIES = [
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'opacity',
  'color',
  'display',
  'visibility',
  'clip-path',
  'clip-rule',
  'stop-color',
  'stop-opacity',
] as const;
export type Property = (typeof PROPERTIES)[number];
const PROPERTY_SET = new Set<string>(PROPERTIES);
export const INHERITED = new Set<Property>([
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'color',
  'visibility',
  'clip-rule',
]);

export function isProperty(name: string): name is Property {
  return PROPERTY_SET.has(name);
}

const NAMED =
  'aliceblue:f0f8ff,antiquewhite:faebd7,aqua:00ffff,aquamarine:7fffd4,azure:f0ffff,beige:f5f5dc,bisque:ffe4c4,black:000000,blanchedalmond:ffebcd,blue:0000ff,blueviolet:8a2be2,brown:a52a2a,burlywood:deb887,cadetblue:5f9ea0,chartreuse:7fff00,chocolate:d2691e,coral:ff7f50,cornflowerblue:6495ed,cornsilk:fff8dc,crimson:dc143c,cyan:00ffff,darkblue:00008b,darkcyan:008b8b,darkgoldenrod:b8860b,darkgray:a9a9a9,darkgreen:006400,darkgrey:a9a9a9,darkkhaki:bdb76b,darkmagenta:8b008b,darkolivegreen:556b2f,darkorange:ff8c00,darkorchid:9932cc,darkred:8b0000,darksalmon:e9967a,darkseagreen:8fbc8f,darkslateblue:483d8b,darkslategray:2f4f4f,darkslategrey:2f4f4f,darkturquoise:00ced1,darkviolet:9400d3,deeppink:ff1493,deepskyblue:00bfff,dimgray:696969,dimgrey:696969,dodgerblue:1e90ff,firebrick:b22222,floralwhite:fffaf0,forestgreen:228b22,fuchsia:ff00ff,gainsboro:dcdcdc,ghostwhite:f8f8ff,gold:ffd700,goldenrod:daa520,gray:808080,green:008000,greenyellow:adff2f,grey:808080,honeydew:f0fff0,hotpink:ff69b4,indianred:cd5c5c,indigo:4b0082,ivory:fffff0,khaki:f0e68c,lavender:e6e6fa,lavenderblush:fff0f5,lawngreen:7cfc00,lemonchiffon:fffacd,lightblue:add8e6,lightcoral:f08080,lightcyan:e0ffff,lightgoldenrodyellow:fafad2,lightgray:d3d3d3,lightgreen:90ee90,lightgrey:d3d3d3,lightpink:ffb6c1,lightsalmon:ffa07a,lightseagreen:20b2aa,lightskyblue:87cefa,lightslategray:778899,lightslategrey:778899,lightsteelblue:b0c4de,lightyellow:ffffe0,lime:00ff00,limegreen:32cd32,linen:faf0e6,magenta:ff00ff,maroon:800000,mediumaquamarine:66cdaa,mediumblue:0000cd,mediumorchid:ba55d3,mediumpurple:9370db,mediumseagreen:3cb371,mediumslateblue:7b68ee,mediumspringgreen:00fa9a,mediumturquoise:48d1cc,mediumvioletred:c71585,midnightblue:191970,mintcream:f5fffa,mistyrose:ffe4e1,moccasin:ffe4b5,navajowhite:ffdead,navy:000080,oldlace:fdf5e6,olive:808000,olivedrab:6b8e23,orange:ffa500,orangered:ff4500,orchid:da70d6,palegoldenrod:eee8aa,palegreen:98fb98,paleturquoise:afeeee,palevioletred:db7093,papayawhip:ffefd5,peachpuff:ffdab9,peru:cd853f,pink:ffc0cb,plum:dda0dd,powderblue:b0e0e6,purple:800080,rebeccapurple:663399,red:ff0000,rosybrown:bc8f8f,royalblue:4169e1,saddlebrown:8b4513,salmon:fa8072,sandybrown:f4a460,seagreen:2e8b57,seashell:fff5ee,sienna:a0522d,silver:c0c0c0,skyblue:87ceeb,slateblue:6a5acd,slategray:708090,slategrey:708090,snow:fffafa,springgreen:00ff7f,steelblue:4682b4,tan:d2b48c,teal:008080,thistle:d8bfd8,tomato:ff6347,turquoise:40e0d0,violet:ee82ee,wheat:f5deb3,white:ffffff,whitesmoke:f5f5f5,yellow:ffff00,yellowgreen:9acd32';

const NAMED_COLOURS = new Map<string, Rgb>(
  NAMED.split(',').map((p) => {
    const [name, hex] = p.split(':') as [string, string];
    return [
      name,
      {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
      },
    ];
  }),
);

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

function channel(t: string): number | null {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(%?)$/.exec(t.trim());
  if (!m) return null;
  const v = Number(m[1]);
  return Math.round(clamp01(m[2] ? v / 100 : v / 255) * 255);
}

function alphaValue(t: string): number | null {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(%?)$/.exec(t.trim());
  if (!m) return null;
  const v = Number(m[1]);
  return clamp01(m[2] ? v / 100 : v);
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const hue = (((h % 360) + 360) % 360) / 360;
  const f = (n: number): number => {
    const k = (n + hue * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return { r: f(0), g: f(8), b: f(4) };
}

/** A CSS colour, or null when the text is not one. `transparent` is an alpha of 0. */
export function parseColour(text: string): { rgb: Rgb; alpha: number } | null {
  const t = text.trim().toLowerCase();
  if (t === 'transparent') return { rgb: { r: 0, g: 0, b: 0 }, alpha: 0 };
  const named = NAMED_COLOURS.get(t);
  if (named) return { rgb: named, alpha: 1 };
  let m = /^#([0-9a-f]{3,8})$/.exec(t);
  if (m) {
    const h = m[1]!;
    const x = (s: string): number => parseInt(s.length === 1 ? s + s : s, 16);
    if (h.length === 3 || h.length === 4)
      return {
        rgb: { r: x(h[0]!), g: x(h[1]!), b: x(h[2]!) },
        alpha: h.length === 4 ? x(h[3]!) / 255 : 1,
      };
    if (h.length === 6 || h.length === 8)
      return {
        rgb: { r: x(h.slice(0, 2)), g: x(h.slice(2, 4)), b: x(h.slice(4, 6)) },
        alpha: h.length === 8 ? x(h.slice(6, 8)) / 255 : 1,
      };
    return null;
  }
  m = /^(rgba?|hsla?)\(([^()]*)\)$/.exec(t);
  if (!m) return null;
  const parts = m[2]!.includes(',')
    ? m[2]!.split(',')
    : m[2]!
        .replace('/', ' / ')
        .trim()
        .split(/\s+/)
        .filter((s) => s !== '/');
  if (parts.length !== 3 && parts.length !== 4) return null;
  const alpha = parts.length === 4 ? alphaValue(parts[3]!) : 1;
  if (alpha === null) return null;
  if (m[1]!.startsWith('rgb')) {
    const [r, g, b] = parts.slice(0, 3).map(channel);
    if (
      r === null ||
      g === null ||
      b === null ||
      r === undefined ||
      g === undefined ||
      b === undefined
    )
      return null;
    return { rgb: { r, g, b }, alpha };
  }
  const h = Number(parts[0]!.replace(/deg$/, ''));
  const s = alphaValue(parts[1]!.endsWith('%') ? parts[1]! : `${parts[1]}%`);
  const l = alphaValue(parts[2]!.endsWith('%') ? parts[2]! : `${parts[2]}%`);
  if (!Number.isFinite(h) || s === null || l === null) return null;
  return { rgb: hslToRgb(h, s, l), alpha };
}

/** Whether a value names another document: an external `url(...)` or `href`. */
export function isExternalReference(value: string): boolean {
  const v = value.trim();
  return !v.startsWith('#');
}

/** Throws if a value could run or fetch something. */
export function checkSafeValue(value: string): void {
  // Browsers ignore white space and control characters inside a scheme ("java\tscript:").
  // eslint-disable-next-line no-control-regex
  const squeezed = value.replace(/[\s\u0000-\u001f]+/g, '').toLowerCase();
  if (/javascript:|vbscript:|expression\(|@import|behavior:|-moz-binding/.test(squeezed))
    throw new AssetError('unsafe_content', 'a script or import in a style or attribute');
  for (const m of value.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi))
    if (isExternalReference(m[2]!))
      throw new AssetError('unsafe_content', 'a reference to another document');
}

/** `url(#id) fallback` or a colour or `none` or `currentColor`; null when invalid. */
export function parsePaint(text: string): PaintSpec | null {
  const t = text.trim();
  if (t === 'none') return { kind: 'none' };
  if (t.toLowerCase() === 'currentcolor') return { kind: 'current' };
  const m = /^url\(\s*(['"]?)#([^'")\s]+)\1\s*\)\s*(.*)$/.exec(t);
  if (m) {
    const fb = m[3]!.trim();
    return { kind: 'url', id: m[2]!, fallback: fb === '' ? null : parsePaint(fb) };
  }
  if (/^url\(/i.test(t)) return null;
  const c = parseColour(t);
  return c ? { kind: 'color', rgb: c.rgb, alpha: c.alpha } : null;
}

const UNIT: Readonly<Record<string, number>> = {
  '': 1,
  px: 1,
  pt: 4 / 3,
  pc: 16,
  mm: 96 / 25.4,
  cm: 96 / 2.54,
  in: 96,
  q: 96 / 101.6,
  em: 16,
  ex: 8,
  rem: 16,
};

/** A length in user units (CSS pixels); percentages are of `ref`. Null when invalid. */
export function parseLength(text: string | undefined, ref: number): number | null {
  if (text === undefined) return null;
  const m =
    /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(px|pt|pc|mm|cm|in|q|em|ex|rem|%)?\s*$/i.exec(
      text,
    );
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v) || Math.abs(v) > 1e9) return null;
  const unit = (m[2] ?? '').toLowerCase();
  if (unit === '%') return (v / 100) * ref;
  return v * UNIT[unit]!;
}

/** A number or percentage (as a fraction). */
export function parseFraction(text: string | undefined): number | null {
  if (text === undefined) return null;
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(%?)\s*$/.exec(text);
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return null;
  return m[2] ? v / 100 : v;
}

/** Declarations of a `style` attribute or rule body, in order, unsupported ones dropped. */
export function parseDeclarations(text: string): [Property, string][] {
  checkSafeValue(text);
  const out: [Property, string][] = [];
  for (const decl of text.replace(/\/\*[\s\S]*?\*\//g, '').split(';')) {
    const c = decl.indexOf(':');
    if (c < 0) continue;
    const name = decl.slice(0, c).trim().toLowerCase();
    const value = decl
      .slice(c + 1)
      .replace(/!\s*important\s*$/i, '')
      .trim();
    if (isProperty(name) && value !== '') out.push([name, value]);
  }
  return out;
}

export interface CssRule {
  tag: string | null;
  id: string | null;
  classes: string[];
  specificity: number;
  order: number;
  decls: [Property, string][];
}

/** Rules of `style` elements; selectors other than compounds of tag, class and id are ignored. */
export function parseStyleSheet(
  text: string,
  start: number,
): { rules: CssRule[]; ignored: number } {
  checkSafeValue(text);
  const src = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: CssRule[] = [];
  let ignored = 0;
  let order = start;
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open < 0) break;
    const prelude = src.slice(i, open).trim();
    // Find the matching close brace (at-rules may nest blocks).
    let depth = 1;
    let j = open + 1;
    for (; j < src.length && depth > 0; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') depth--;
    }
    const body = src.slice(open + 1, j - 1);
    i = j;
    if (prelude.startsWith('@')) {
      ignored++;
      continue;
    }
    const decls = parseDeclarations(body);
    for (const sel of prelude.split(',')) {
      const s = sel.trim();
      const m = /^([A-Za-z][A-Za-z0-9-]*)?((?:[.#][A-Za-z_-][A-Za-z0-9_-]*)*)$/.exec(s);
      if (!m || s === '') {
        ignored++;
        continue;
      }
      const tag = m[1] ?? null;
      let id: string | null = null;
      const classes: string[] = [];
      for (const part of m[2]!.match(/[.#][A-Za-z0-9_-]+/g) ?? []) {
        if (part[0] === '#') id = part.slice(1);
        else classes.push(part.slice(1));
      }
      rules.push({
        tag,
        id,
        classes,
        specificity: (id ? 10000 : 0) + classes.length * 100 + (tag ? 1 : 0),
        order: order++,
        decls,
      });
    }
  }
  rules.sort((a, b) => a.specificity - b.specificity || a.order - b.order);
  return { rules, ignored };
}
