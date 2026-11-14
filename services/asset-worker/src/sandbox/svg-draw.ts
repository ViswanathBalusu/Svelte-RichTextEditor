/**
 * Turns a parsed SVG upload into a flat drawing: a list of filled or stroked paths, each with its
 * full transform, paint and clips (BE-043 criterion 5). Both outputs are written from this list
 * only (svg-write.ts), so neither can contain anything the list cannot express.
 *
 * Supported: `svg` (nested too), `g`, `a` (drawn as a group, its link dropped), `switch` (its
 * first child), `defs`, `symbol` and `use` (internal references only, with a cycle check), the
 * basic shapes and `path`, linear and radial gradients, `clipPath`, `style` elements and
 * attributes. Refused: scripts, event handlers, `foreignObject`, `iframe`, `object`, `embed`, any
 * reference to another document (unsafe); `image` and text (unsupported). Dropped with a note:
 * animation, filters, masks, markers, patterns, unknown elements.
 *
 * Every element visited while drawing counts against `svgMaxDrawn`, references included, and
 * every path command emitted against `svgMaxPathCommands`, so a chain of `<use>` references that
 * multiplies its content (a reference bomb) fails at the limit.
 */
import { AssetError } from './errors.ts';
import type { ContentLimits } from './limits.ts';
import {
  bbox,
  ellipse,
  IDENTITY,
  invertible,
  mul,
  parsePathData,
  parseTransform,
  parseViewBox,
  polyline,
  rect,
  transformSegs,
  viewBoxTransform,
  type Mat,
  type Seg,
} from './svg-path.ts';
import {
  checkSafeValue,
  INHERITED,
  isExternalReference,
  isProperty,
  parseColour,
  parseDeclarations,
  parseFraction,
  parseLength,
  parsePaint,
  parseStyleSheet,
  PROPERTIES,
  type CssRule,
  type PaintSpec,
  type Property,
  type Rgb,
} from './svg-style.ts';
import type { XmlElement } from './svg-xml.ts';

export interface GradientStop {
  offset: number;
  rgb: Rgb;
  opacity: number;
}

export interface Gradient {
  type: 'linear' | 'radial';
  /** Gradient space to the shape's user space (bounding box and gradientTransform applied). */
  matrix: Mat;
  /** Linear: x1 y1 x2 y2; radial: fx fy fr cx cy r. */
  coords: number[];
  stops: GradientStop[];
}

export type Paint = { kind: 'rgb'; rgb: Rgb } | { kind: 'gradient'; gradient: Gradient };

export interface Clip {
  /** In the drawing's root space. */
  segs: Seg[];
  rule: 'nonzero' | 'evenodd';
}

export interface Shape {
  segs: Seg[];
  /** The shape's user space to the root space (CSS pixels, origin top left). */
  ctm: Mat;
  fill: Paint | null;
  fillOpacity: number;
  fillRule: 'nonzero' | 'evenodd';
  stroke: Paint | null;
  strokeOpacity: number;
  strokeWidth: number;
  lineCap: 'butt' | 'round' | 'square';
  lineJoin: 'miter' | 'round' | 'bevel';
  miterLimit: number;
  dash: number[] | null;
  dashOffset: number;
  clips: Clip[];
}

export interface Drawing {
  width: number;
  height: number;
  shapes: Shape[];
  notes: string[];
}

type Computed = Record<Property, string>;
type Box = [number, number, number, number];

const INITIAL: Computed = {
  fill: 'black',
  'fill-opacity': '1',
  'fill-rule': 'nonzero',
  stroke: 'none',
  'stroke-width': '1',
  'stroke-opacity': '1',
  'stroke-linecap': 'butt',
  'stroke-linejoin': 'miter',
  'stroke-miterlimit': '4',
  'stroke-dasharray': 'none',
  'stroke-dashoffset': '0',
  opacity: '1',
  color: 'black',
  display: 'inline',
  visibility: 'visible',
  'clip-path': 'none',
  'clip-rule': 'nonzero',
  'stop-color': 'black',
  'stop-opacity': '1',
};

const UNSAFE = new Set([
  'script',
  'foreignObject',
  'iframe',
  'object',
  'embed',
  'handler',
  'listener',
]);
const UNSUPPORTED = new Set([
  'text',
  'tspan',
  'textPath',
  'tref',
  'altGlyph',
  'font',
  'font-face',
  'glyph',
  'image',
]);
const ANIMATION = new Set([
  'animate',
  'animateTransform',
  'animateMotion',
  'animateColor',
  'set',
  'mpath',
  'discard',
]);
const EFFECTS = new Set(['filter', 'mask', 'marker', 'pattern']);
const SILENT = new Set([
  'title',
  'desc',
  'metadata',
  'style',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
  'view',
  'cursor',
  'defs',
  'symbol',
]);
const SHAPES = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);
const CONTAINERS = new Set(['g', 'a', 'switch', 'svg']);
const MAX_REFERENCE_DEPTH = 16;
const MAX_CSS_RULES = 10_000;

interface GradientBase {
  top: XmlElement;
  attr: (name: string) => string | undefined;
  stops: GradientStop[];
}

interface ClipBase {
  /** In the clip path's content space (children's transforms applied). */
  segs: Seg[];
  rule: 'nonzero' | 'evenodd';
  units: 'user' | 'box';
  transform: Mat | null;
}

class Builder {
  readonly limits: ContentLimits;
  readonly ids = new Map<string, XmlElement>();
  readonly rules: CssRule[] = [];
  readonly buckets = new Map<string, CssRule[]>();
  readonly notes = new Set<string>();
  readonly shapes: Shape[] = [];
  readonly gradients = new Map<XmlElement, GradientBase | null>();
  readonly clipCache = new Map<XmlElement, ClipBase | 'hidden'>();
  viewport: [number, number] = [0, 0];
  pathCommands = 0;
  visits = 0;

  constructor(limits: ContentLimits) {
    this.limits = limits;
  }

  /** Walks the tree once: unsafe elements and attributes, identifiers, style sheets. */
  scan(el: XmlElement): void {
    if (UNSAFE.has(el.name))
      throw new AssetError('unsafe_content', `the SVG element ${el.name} is not allowed`);
    for (const [name, value] of el.attrs) {
      if (/^on/i.test(name)) throw new AssetError('unsafe_content', 'an event handler attribute');
      checkSafeValue(value);
      if (name === 'href' && el.name !== 'a' && isExternalReference(value)) {
        if (el.name === 'image' && /^\s*data:/i.test(value))
          throw new AssetError(
            'unsupported_content',
            'an SVG with an embedded image is not supported',
          );
        throw new AssetError('unsafe_content', 'a reference to another document');
      }
    }
    if (el.name === 'image')
      throw new AssetError('unsupported_content', 'an SVG with an image element is not supported');
    const id = el.attrs.get('id');
    if (id !== undefined && !this.ids.has(id)) this.ids.set(id, el);
    if (el.name === 'style') {
      const type = el.attrs.get('type');
      if (type === undefined || type.trim().toLowerCase() === 'text/css') {
        const sheet = parseStyleSheet(el.text, this.rules.length);
        this.rules.push(...sheet.rules);
        if (this.rules.length > MAX_CSS_RULES)
          throw new AssetError('drawing_limit', `more than ${MAX_CSS_RULES} style rules`);
        if (sheet.ignored > 0) this.notes.add('css_rules_ignored');
      }
    }
    for (const c of el.children) this.scan(c);
  }

  /** Indexes the rules by their most specific simple selector. */
  indexRules(): void {
    for (const r of this.rules) {
      const key = r.id
        ? `#${r.id}`
        : r.classes.length > 0
          ? `.${r.classes[0]}`
          : r.tag
            ? `t:${r.tag}`
            : '*';
      const list = this.buckets.get(key) ?? [];
      list.push(r);
      this.buckets.set(key, list);
    }
  }

  matching(el: XmlElement): CssRule[] {
    if (this.rules.length === 0) return [];
    const classes = (el.attrs.get('class') ?? '').split(/\s+/).filter(Boolean);
    const id = el.attrs.get('id');
    const keys = ['*', `t:${el.name}`, ...classes.map((c) => `.${c}`)];
    if (id !== undefined) keys.push(`#${id}`);
    const out: CssRule[] = [];
    const seen = new Set<CssRule>();
    for (const k of keys)
      for (const r of this.buckets.get(k) ?? []) {
        if (seen.has(r)) continue;
        seen.add(r);
        if (r.tag && r.tag !== el.name) continue;
        if (r.id && r.id !== id) continue;
        if (!r.classes.every((c) => classes.includes(c))) continue;
        out.push(r);
      }
    return out.sort((a, b) => a.specificity - b.specificity || a.order - b.order);
  }

  /** Computed style of `el` given its parent's: attributes, then style rules, then `style`. */
  style(el: XmlElement, parent: Computed): Computed {
    const out = { ...INITIAL };
    for (const p of PROPERTIES) if (INHERITED.has(p)) out[p] = parent[p];
    const set = (p: Property, v: string): void => {
      const t = v.trim();
      if (t === 'inherit') out[p] = parent[p];
      else if (t !== '') out[p] = t;
    };
    for (const [name, value] of el.attrs) if (isProperty(name)) set(name, value);
    for (const r of this.matching(el)) for (const [p, v] of r.decls) set(p, v);
    const inline = el.attrs.get('style');
    if (inline) for (const [p, v] of parseDeclarations(inline)) set(p, v);
    return out;
  }

  length(v: string | undefined, ref: number, fallback: number): number {
    const n = parseLength(v, ref);
    return n === null ? fallback : n;
  }

  get diagonal(): number {
    const [w, h] = this.viewport;
    return Math.sqrt((w * w + h * h) / 2);
  }

  /** The element's own transform; null when invalid (the element is then not drawn). */
  transformOf(el: XmlElement): Mat | null {
    const t = el.attrs.get('transform');
    return t === undefined ? IDENTITY : parseTransform(t);
  }

  visit(): void {
    if (++this.visits > this.limits.svgMaxDrawn)
      throw new AssetError(
        'drawing_limit',
        `the drawing expands to more than ${this.limits.svgMaxDrawn} elements`,
      );
  }

  commands(n: number): void {
    this.pathCommands += n;
    if (this.pathCommands > this.limits.svgMaxPathCommands)
      throw new AssetError(
        'drawing_limit',
        `the drawing has more than ${this.limits.svgMaxPathCommands} path commands`,
      );
  }

  geometry(el: XmlElement): Seg[] {
    const [vw, vh] = this.viewport;
    const a = el.attrs;
    switch (el.name) {
      case 'path': {
        const d = a.get('d');
        if (d === undefined) return [];
        const r = parsePathData(d);
        if (r.error) this.notes.add('path_data_error');
        return r.segs;
      }
      case 'rect': {
        const w = this.length(a.get('width'), vw, 0);
        const h = this.length(a.get('height'), vh, 0);
        if (!(w > 0 && h > 0)) return [];
        const rxA = parseLength(a.get('rx'), vw);
        const ryA = parseLength(a.get('ry'), vh);
        return rect(
          this.length(a.get('x'), vw, 0),
          this.length(a.get('y'), vh, 0),
          w,
          h,
          rxA ?? ryA ?? 0,
          ryA ?? rxA ?? 0,
        );
      }
      case 'circle': {
        const r = this.length(a.get('r'), this.diagonal, 0);
        if (!(r > 0)) return [];
        return ellipse(this.length(a.get('cx'), vw, 0), this.length(a.get('cy'), vh, 0), r, r);
      }
      case 'ellipse': {
        const rxA = parseLength(a.get('rx'), vw);
        const ryA = parseLength(a.get('ry'), vh);
        const rx = rxA ?? ryA ?? 0;
        const ry = ryA ?? rxA ?? 0;
        if (!(rx > 0 && ry > 0)) return [];
        return ellipse(this.length(a.get('cx'), vw, 0), this.length(a.get('cy'), vh, 0), rx, ry);
      }
      case 'line':
        return [
          { op: 'M', x: this.length(a.get('x1'), vw, 0), y: this.length(a.get('y1'), vh, 0) },
          { op: 'L', x: this.length(a.get('x2'), vw, 0), y: this.length(a.get('y2'), vh, 0) },
        ];
      case 'polyline':
      case 'polygon':
        return polyline(a.get('points') ?? '', el.name === 'polygon');
      default:
        return [];
    }
  }

  opacity(v: string): number {
    const n = parseFraction(v);
    return n === null ? 1 : Math.min(1, Math.max(0, n));
  }

  /** A gradient's attributes and stops, following `href` (SVG 1.1 §13.2.2); cached per element. */
  gradientBase(el: XmlElement): GradientBase | null {
    const cached = this.gradients.get(el);
    if (cached !== undefined) return cached;
    const chain: XmlElement[] = [];
    let cur: XmlElement | undefined = el;
    while (cur && chain.length < MAX_REFERENCE_DEPTH && !chain.includes(cur)) {
      if (cur.name !== 'linearGradient' && cur.name !== 'radialGradient') break;
      chain.push(cur);
      const href = cur.attrs.get('href');
      cur = href && href.startsWith('#') ? this.ids.get(href.slice(1)) : undefined;
    }
    const top = chain[0];
    if (!top) {
      this.gradients.set(el, null);
      return null;
    }
    const attr = (n: string): string | undefined => {
      for (const g of chain) {
        const v = g.attrs.get(n);
        if (v !== undefined) return v;
      }
      return undefined;
    };
    const stopsEl = chain.find((g) => g.children.some((c) => c.name === 'stop'));
    const stops: GradientStop[] = [];
    let last = 0;
    for (const s of stopsEl?.children.filter((c) => c.name === 'stop') ?? []) {
      const st = this.style(s, INITIAL);
      const off = Math.min(1, Math.max(last, parseFraction(s.attrs.get('offset') ?? '0') ?? 0));
      last = off;
      const colour =
        st['stop-color'].toLowerCase() === 'currentcolor'
          ? parseColour(st.color)
          : parseColour(st['stop-color']);
      const c = colour ?? { rgb: { r: 0, g: 0, b: 0 }, alpha: 1 };
      stops.push({ offset: off, rgb: c.rgb, opacity: this.opacity(st['stop-opacity']) * c.alpha });
    }
    const base = { top, attr, stops };
    this.gradients.set(el, base);
    return base;
  }

  /** A gradient for a shape whose bounding box (user space) is `box`. */
  gradient(id: string, box: Box | null): Gradient | 'none' | null {
    const el = this.ids.get(id);
    const base = el ? this.gradientBase(el) : null;
    if (!base) return null;
    const { top, attr, stops } = base;
    if (stops.length === 0) return 'none';
    const units = attr('gradientUnits') === 'userSpaceOnUse' ? 'user' : 'box';
    const gt = attr('gradientTransform');
    const gtm = gt === undefined ? IDENTITY : (parseTransform(gt) ?? IDENTITY);
    const spread = attr('spreadMethod');
    if (spread === 'reflect' || spread === 'repeat') this.notes.add('gradient_spread_padded');
    let space: Mat;
    if (units === 'box') {
      if (!box || box[2] - box[0] <= 0 || box[3] - box[1] <= 0) return 'none';
      space = mul([box[2] - box[0], 0, 0, box[3] - box[1], box[0], box[1]], gtm);
    } else space = gtm;
    const [vw, vh] = this.viewport;
    const len = (n: string, ref: number, dflt: number): number => {
      const v = attr(n);
      if (v === undefined) return dflt;
      return (units === 'box' ? parseFraction(v) : parseLength(v, ref)) ?? dflt;
    };
    if (top.name === 'linearGradient')
      return {
        type: 'linear',
        matrix: space,
        coords: [
          len('x1', vw, 0),
          len('y1', vh, 0),
          len('x2', vw, units === 'box' ? 1 : vw),
          len('y2', vh, 0),
        ],
        stops,
      };
    const cx = len('cx', vw, units === 'box' ? 0.5 : vw / 2);
    const cy = len('cy', vh, units === 'box' ? 0.5 : vh / 2);
    const r = len('r', this.diagonal, units === 'box' ? 0.5 : this.diagonal / 2);
    if (!(r > 0)) return 'none';
    return {
      type: 'radial',
      matrix: space,
      coords: [
        len('fx', vw, cx),
        len('fy', vh, cy),
        Math.max(0, len('fr', this.diagonal, 0)),
        cx,
        cy,
        r,
      ],
      stops,
    };
  }

  paint(spec: string, st: Computed, box: Box | null): { paint: Paint | null; alpha: number } {
    const resolve = (q: PaintSpec | null): { paint: Paint | null; alpha: number } => {
      if (!q || q.kind === 'none') return { paint: null, alpha: 1 };
      if (q.kind === 'current') {
        const c = parseColour(st.color);
        return c
          ? { paint: { kind: 'rgb', rgb: c.rgb }, alpha: c.alpha }
          : { paint: null, alpha: 1 };
      }
      if (q.kind === 'color') return { paint: { kind: 'rgb', rgb: q.rgb }, alpha: q.alpha };
      const g = this.gradient(q.id, box);
      if (g === 'none') return { paint: null, alpha: 1 };
      if (g === null) {
        if (this.ids.has(q.id)) this.notes.add('unsupported_paint');
        return resolve(q.fallback);
      }
      if (g.stops.length === 1)
        return { paint: { kind: 'rgb', rgb: g.stops[0]!.rgb }, alpha: g.stops[0]!.opacity };
      if (new Set(g.stops.map((s) => s.opacity)).size > 1)
        this.notes.add('gradient_opacity_ignored');
      return { paint: { kind: 'gradient', gradient: g }, alpha: g.stops[0]!.opacity };
    };
    return resolve(parsePaint(spec));
  }

  /** A clip path's geometry in its own content space; cached per element. */
  clipBase(cp: XmlElement): ClipBase | 'hidden' {
    const cached = this.clipCache.get(cp);
    if (cached !== undefined) return cached;
    const segs: Seg[] = [];
    let rule: 'nonzero' | 'evenodd' = 'nonzero';
    let count = 0;
    const visit = (c: XmlElement, m0: Mat, parentStyle: Computed, depth: number): void => {
      if (depth > MAX_REFERENCE_DEPTH)
        throw new AssetError('drawing_limit', 'references nested too deeply');
      this.visit();
      const cs = this.style(c, parentStyle);
      if (cs.display === 'none') return;
      const t = this.transformOf(c);
      if (!t) return;
      const m1 = mul(m0, t);
      if (SHAPES.has(c.name)) {
        segs.push(...transformSegs(this.geometry(c), m1));
        rule = cs['clip-rule'] === 'evenodd' ? 'evenodd' : 'nonzero';
        count++;
      } else if (c.name === 'use') {
        const href = c.attrs.get('href');
        const target = href && href.startsWith('#') ? this.ids.get(href.slice(1)) : undefined;
        if (target && SHAPES.has(target.name)) {
          const x = this.length(c.attrs.get('x'), this.viewport[0], 0);
          const y = this.length(c.attrs.get('y'), this.viewport[1], 0);
          visit(target, mul(m1, [1, 0, 0, 1, x, y]), cs, depth + 1);
        }
      } else if (UNSUPPORTED.has(c.name))
        throw new AssetError('unsupported_content', 'text in an SVG clip path is not supported');
    };
    const cpStyle = this.style(cp, INITIAL);
    for (const c of cp.children) visit(c, IDENTITY, cpStyle, 1);
    if (count > 1) this.notes.add('clip_union_approximated');
    const base: ClipBase | 'hidden' =
      segs.length === 0
        ? 'hidden'
        : {
            segs,
            rule,
            units: cp.attrs.get('clipPathUnits') === 'objectBoundingBox' ? 'box' : 'user',
            transform: this.transformOf(cp),
          };
    this.clipCache.set(cp, base);
    return base;
  }

  clipFor(st: Computed, ctm: Mat, box: Box | null): Clip[] | 'hidden' {
    const v = st['clip-path'].trim();
    if (v === 'none') return [];
    const m = /^url\(\s*(['"]?)#([^'")\s]+)\1\s*\)$/.exec(v);
    const cp = m ? this.ids.get(m[2]!) : undefined;
    if (!cp || cp.name !== 'clipPath') {
      this.notes.add('clip_ignored');
      return [];
    }
    const base = this.clipBase(cp);
    if (base === 'hidden' || !base.transform) return 'hidden';
    let m0 = ctm;
    if (base.units === 'box') {
      if (!box || box[2] <= box[0] || box[3] <= box[1]) return 'hidden';
      m0 = mul(ctm, [box[2] - box[0], 0, 0, box[3] - box[1], box[0], box[1]]);
    }
    this.commands(base.segs.length);
    return [{ segs: transformSegs(base.segs, mul(m0, base.transform)), rule: base.rule }];
  }

  /** Draws `el` and its subtree. */
  draw(
    el: XmlElement,
    parentStyle: Computed,
    ctm: Mat,
    alpha: number,
    clips: Clip[],
    stack: XmlElement[],
  ): void {
    this.visit();
    if (stack.length > MAX_REFERENCE_DEPTH * 4)
      throw new AssetError('drawing_limit', 'elements nested too deeply');
    const name = el.name;
    if (UNSAFE.has(name))
      throw new AssetError('unsafe_content', `the SVG element ${name} is not allowed`);
    if (UNSUPPORTED.has(name))
      throw new AssetError(
        'unsupported_content',
        'text and images in an SVG are not supported; convert text to outlines',
      );
    if (ANIMATION.has(name)) {
      this.notes.add('animation_removed');
      return;
    }
    if (EFFECTS.has(name)) {
      this.notes.add(`${name}_removed`);
      return;
    }
    if (SILENT.has(name)) return;
    const st = this.style(el, parentStyle);
    if (st.display === 'none') return;
    for (const p of ['filter', 'mask', 'marker-start', 'marker-mid', 'marker-end'])
      if (el.attrs.has(p)) this.notes.add(`${p.split('-')[0]}_removed`);
    const t = this.transformOf(el);
    if (!t) {
      this.notes.add('invalid_transform');
      return;
    }
    let m = mul(ctm, t);
    const a = alpha * this.opacity(st.opacity);
    if (a !== alpha && !SHAPES.has(name)) this.notes.add('group_opacity_approximated');
    if (SHAPES.has(name)) {
      const segs = this.geometry(el);
      if (
        segs.length === 0 ||
        st.visibility === 'hidden' ||
        st.visibility === 'collapse' ||
        !invertible(m)
      )
        return;
      this.commands(segs.length);
      const box = bbox(segs);
      const own = this.clipFor(st, m, box);
      if (own === 'hidden') return;
      // A line has no inside to fill (SVG 1.1 §9.5).
      const fill = name === 'line' ? { paint: null, alpha: 1 } : this.paint(st.fill, st, box);
      const stroke = this.paint(st.stroke, st, box);
      const width = parseLength(st['stroke-width'], this.diagonal) ?? 1;
      const strokePaint = width > 0 ? stroke.paint : null;
      if (!fill.paint && !strokePaint) return;
      let dash: number[] | null = null;
      if (st['stroke-dasharray'] !== 'none') {
        const parts = st['stroke-dasharray']
          .split(/[\s,]+/)
          .filter(Boolean)
          .map((p) => parseLength(p, this.diagonal));
        const valid = parts.every((p): p is number => p !== null && p >= 0);
        if (valid && parts.some((p) => p! > 0)) {
          const nums = parts as number[];
          dash = nums.length % 2 === 1 ? [...nums, ...nums] : nums;
        }
      }
      const cap = st['stroke-linecap'];
      const join = st['stroke-linejoin'];
      this.shapes.push({
        segs,
        ctm: m,
        fill: fill.paint,
        fillOpacity: this.opacity(st['fill-opacity']) * fill.alpha * a,
        fillRule: st['fill-rule'] === 'evenodd' ? 'evenodd' : 'nonzero',
        stroke: strokePaint,
        strokeOpacity: this.opacity(st['stroke-opacity']) * stroke.alpha * a,
        strokeWidth: width,
        lineCap: cap === 'round' || cap === 'square' ? cap : 'butt',
        lineJoin: join === 'round' || join === 'bevel' ? join : 'miter',
        miterLimit: Math.max(1, parseFraction(st['stroke-miterlimit']) ?? 4),
        dash,
        dashOffset: parseLength(st['stroke-dashoffset'], this.diagonal) ?? 0,
        clips: [...clips, ...own],
      });
      return;
    }
    if (name === 'use') {
      const href = el.attrs.get('href');
      const target = href && href.startsWith('#') ? this.ids.get(href.slice(1)) : undefined;
      if (!target) return;
      if (stack.includes(target)) {
        this.notes.add('reference_cycle_ignored');
        return;
      }
      const x = this.length(el.attrs.get('x'), this.viewport[0], 0);
      const y = this.length(el.attrs.get('y'), this.viewport[1], 0);
      m = mul(m, [1, 0, 0, 1, x, y]);
      const own = this.clipFor(st, m, null);
      if (own === 'hidden') return;
      const cl = [...clips, ...own];
      if (target.name === 'symbol' || target.name === 'svg') {
        const w = this.length(
          el.attrs.get('width') ?? target.attrs.get('width'),
          this.viewport[0],
          this.viewport[0],
        );
        const h = this.length(
          el.attrs.get('height') ?? target.attrs.get('height'),
          this.viewport[1],
          this.viewport[1],
        );
        const vb = parseViewBox(target.attrs.get('viewBox'));
        const inner = vb
          ? mul(m, viewBoxTransform(vb, w, h, target.attrs.get('preserveAspectRatio')))
          : m;
        const ts = this.style(target, st);
        for (const c of target.children) this.draw(c, ts, inner, a, cl, [...stack, el, target]);
        return;
      }
      this.draw(target, st, m, a, cl, [...stack, el]);
      return;
    }
    if (CONTAINERS.has(name)) {
      if (name === 'a' && el.attrs.has('href')) this.notes.add('link_removed');
      if (name === 'svg') {
        const x = this.length(el.attrs.get('x'), this.viewport[0], 0);
        const y = this.length(el.attrs.get('y'), this.viewport[1], 0);
        const w = this.length(el.attrs.get('width'), this.viewport[0], this.viewport[0]);
        const h = this.length(el.attrs.get('height'), this.viewport[1], this.viewport[1]);
        const vb = parseViewBox(el.attrs.get('viewBox'));
        m = mul(m, [1, 0, 0, 1, x, y]);
        if (vb) m = mul(m, viewBoxTransform(vb, w, h, el.attrs.get('preserveAspectRatio')));
        this.notes.add('nested_viewport_not_clipped');
      }
      const own = this.clipFor(st, m, null);
      if (own === 'hidden') return;
      const cl = [...clips, ...own];
      const kids =
        name === 'switch'
          ? el.children.filter((c) => !UNSUPPORTED.has(c.name)).slice(0, 1)
          : el.children;
      for (const c of kids) this.draw(c, st, m, a, cl, [...stack, el]);
      return;
    }
    this.notes.add('unknown_element_removed');
  }
}

/** A page larger than 200 inches on a side (PDF's usual maximum) is scaled down to fit. */
const MAX_PAGE_PX = 19_200;

/** Builds the drawing of a parsed SVG upload. */
export function buildDrawing(root: XmlElement, limits: ContentLimits): Drawing {
  const b = new Builder(limits);
  b.scan(root);
  b.indexRules();
  const vb = parseViewBox(root.attrs.get('viewBox'));
  const sized = (n: string): number | null => {
    const v = root.attrs.get(n);
    return v === undefined || v.includes('%') ? null : parseLength(v, 0);
  };
  const wAttr = sized('width');
  const hAttr = sized('height');
  let width: number;
  let height: number;
  if (wAttr !== null && hAttr !== null) {
    width = wAttr;
    height = hAttr;
  } else if (vb) {
    width = wAttr ?? (hAttr !== null ? (hAttr * vb[2]) / vb[3] : vb[2]);
    height = hAttr ?? (wAttr !== null ? (wAttr * vb[3]) / vb[2] : vb[3]);
  } else {
    width = wAttr ?? 300;
    height = hAttr ?? 150;
    b.notes.add('default_size');
  }
  if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height))
    throw new AssetError('malformed', 'an SVG without a usable size');
  let scale = 1;
  if (width > MAX_PAGE_PX || height > MAX_PAGE_PX) {
    scale = MAX_PAGE_PX / Math.max(width, height);
    b.notes.add('scaled_to_fit');
  }
  b.viewport = vb ? [vb[2], vb[3]] : [width, height];
  let ctm: Mat = [scale, 0, 0, scale, 0, 0];
  if (vb)
    ctm = mul(ctm, viewBoxTransform(vb, width, height, root.attrs.get('preserveAspectRatio')));
  const rootStyle = b.style(root, INITIAL);
  const rootT = b.transformOf(root);
  if (rootT) ctm = mul(ctm, rootT);
  if (rootStyle.display !== 'none') {
    const a = b.opacity(rootStyle.opacity);
    for (const c of root.children) b.draw(c, rootStyle, ctm, a, [], [root]);
  }
  return {
    width: width * scale,
    height: height * scale,
    shapes: b.shapes,
    notes: [...b.notes].sort(),
  };
}
