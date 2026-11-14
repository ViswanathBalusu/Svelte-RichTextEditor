/**
 * Spike S5's measurement page (SPK-018). For the same sample lines in the same font files, it
 * measures in this browser:
 *
 * - canvas `measureText` widths (a DOM canvas, the default settings, and where the browser has
 *   them `fontKerning = 'none'` and `textRendering = 'optimizeSpeed'`);
 * - painted widths: each line in its own box with `white-space: pre`, one span per segment, as
 *   the painter of 02 §9.3 places lines; with CSS defaults, with kerning and ligatures named
 *   explicitly, and with both turned off;
 * - widths from the two WebAssembly shapers, harfbuzzjs and the HarfRust module, with their
 *   default features and with kerning and ligatures off; a digest of every glyph, cluster and
 *   advance, to compare across browsers and Node.js;
 * - load, compile and instantiate times and linear memory of each module.
 *
 * The Playwright spec (e2e/s5.spec.ts) passes the lines and the faces and keeps the result.
 */
import hbWasmUrl from 'harfbuzzjs/dist/harfbuzz.wasm?url';
import type { FontManifestEntry } from '../fonts.ts';
import type { SampleLine } from '../lines.ts';
import { loadHarfbuzz } from '../shapers/harfbuzz.ts';
import { harfrustShaper, loadTextKernel } from '../shapers/harfrust.ts';
import { shapeLines } from '../s5.ts';
import { timeCompile } from '../wasm.ts';

export interface S5Input {
  lines: SampleLine[];
  faces: FontManifestEntry[];
  compileRuns: number;
}

type Widths = Record<string, number[]>;

const alias = (f: FontManifestEntry): string => `S5 ${f.alias}`;
const fontCss = (f: FontManifestEntry, sizePx: number): string =>
  `${f.style} ${f.weight} ${sizePx}px "${alias(f)}"`;

async function loadFaces(faces: FontManifestEntry[]): Promise<Map<string, Uint8Array>> {
  const bytes = new Map<string, Uint8Array>();
  for (const f of faces) {
    const buf = new Uint8Array(await (await fetch(`/fonts/${f.file}`)).arrayBuffer());
    bytes.set(f.file, buf);
    const face = new FontFace(alias(f), buf, { weight: String(f.weight), style: f.style });
    await face.load();
    document.fonts.add(face);
  }
  await document.fonts.ready;
  return bytes;
}

function canvasWidths(
  lines: SampleLine[],
  faces: Map<string, FontManifestEntry>,
): { widths: Widths; support: Record<string, boolean>; ms: number } {
  const ctx = document.createElement('canvas').getContext('2d')!;
  const c = ctx as CanvasRenderingContext2D & { fontKerning?: string; textRendering?: string };
  const support = {
    fontKerning: 'fontKerning' in c,
    textRendering: 'textRendering' in c,
    letterSpacing: 'letterSpacing' in c,
    fontVariantCaps: 'fontVariantCaps' in c,
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
  };
  const variants: [string, (() => void) | null][] = [
    ['default', null],
    ['noKerning', support.fontKerning ? () => (c.fontKerning = 'none') : null],
    ['optimizeSpeed', support.textRendering ? () => (c.textRendering = 'optimizeSpeed') : null],
  ];
  const widths: Widths = {};
  const t0 = performance.now();
  for (const [name, set] of variants) {
    if (name !== 'default' && !set) continue;
    const out: number[] = [];
    for (const line of lines) {
      let w = 0;
      for (const s of line.segments) {
        ctx.font = fontCss(faces.get(s.face)!, s.sizePx);
        if (support.fontKerning) c.fontKerning = 'auto';
        if (support.textRendering) c.textRendering = 'auto';
        set?.();
        w += ctx.measureText(s.text).width;
      }
      out.push(w);
    }
    widths[name] = out;
  }
  return { widths, support, ms: performance.now() - t0 };
}

const PAINT_VARIANTS: Record<string, string> = {
  default: '',
  explicit: 'font-kerning: normal; font-variant-ligatures: common-ligatures contextual;',
  none: 'font-kerning: none; font-variant-ligatures: none;',
  // CSS Text 4: Chromium trims the spacing of adjacent full-width punctuation by default.
  spaceAll: 'text-spacing-trim: space-all;',
};

function paintedWidths(
  lines: SampleLine[],
  faces: Map<string, FontManifestEntry>,
): { widths: Widths; ms: number } {
  const host = document.getElementById('lines')!;
  const widths: Widths = {};
  const t0 = performance.now();
  for (const [name, extra] of Object.entries(PAINT_VARIANTS)) {
    const boxes: HTMLSpanElement[] = [];
    const frag = document.createDocumentFragment();
    for (const line of lines) {
      const div = document.createElement('div');
      const box = document.createElement('span');
      for (const s of line.segments) {
        const span = document.createElement('span');
        // The font shorthand resets font-kerning and font-variant-ligatures, so they follow it.
        span.setAttribute('style', `font: ${fontCss(faces.get(s.face)!, s.sizePx)}; ${extra}`);
        span.textContent = s.text;
        box.append(span);
      }
      div.append(box);
      frag.append(div);
      boxes.push(box);
    }
    host.append(frag);
    widths[name] = boxes.map((b) => b.getBoundingClientRect().width);
    host.replaceChildren();
  }
  return { widths, ms: performance.now() - t0 };
}

async function run(input: S5Input): Promise<unknown> {
  const faces = new Map(input.faces.map((f) => [f.file, f]));
  const latin = input.lines.filter((l) => l.role === 'latin');
  const cjk = input.lines.filter((l) => l.role !== 'latin');
  const t0 = performance.now();
  const bytes = await loadFaces(input.faces);
  const fontsMs = performance.now() - t0;

  const canvas = canvasWidths(input.lines, faces);
  const painted = paintedWidths(input.lines, faces);

  // harfbuzzjs: import (fetch, compile, instantiate), then the fonts, Latin first.
  const hb = await loadHarfbuzz();
  const hbMem: Record<string, number> = { afterImport: hb.shaper.memoryBytes() };
  for (const f of input.faces.filter((x) => x.role === 'latin'))
    hb.shaper.loadFont(f.file, bytes.get(f.file)!);
  const hbLatin = await shapeLines(hb.shaper, latin);
  hbMem['afterLatin'] = hb.shaper.memoryBytes();
  for (const f of input.faces.filter((x) => x.role !== 'latin'))
    hb.shaper.loadFont(f.file, bytes.get(f.file)!);
  const hbCjk = await shapeLines(hb.shaper, cjk);
  hbMem['afterCjk'] = hb.shaper.memoryBytes();

  // HarfRust: fetch and instantiate the shaper-only module, then the same fonts.
  const tf = performance.now();
  const hrBytes = new Uint8Array(await (await fetch('/wasm/harfrust-shaper.wasm')).arrayBuffer());
  const fetchMs = performance.now() - tf;
  const loaded = await loadTextKernel(hrBytes);
  const hr = harfrustShaper(loaded.module);
  const hrMem: Record<string, number> = { afterInstantiate: hr.memoryBytes() };
  for (const f of input.faces.filter((x) => x.role === 'latin'))
    hr.loadFont(f.file, bytes.get(f.file)!);
  const hrLatin = await shapeLines(hr, latin);
  hrMem['afterLatin'] = hr.memoryBytes();
  for (const f of input.faces.filter((x) => x.role !== 'latin'))
    hr.loadFont(f.file, bytes.get(f.file)!);
  const hrCjk = await shapeLines(hr, cjk);
  hrMem['afterCjk'] = hr.memoryBytes();

  // Compile and instantiate, repeated, from the bytes.
  const hbBytes = new Uint8Array(await (await fetch(hbWasmUrl)).arrayBuffer());
  const kernelBytes = new Uint8Array(await (await fetch('/wasm/text-kernel.wasm')).arrayBuffer());
  const compile = {
    harfbuzz: await timeCompile(hbBytes, input.compileRuns),
    harfrustShaper: await timeCompile(hrBytes, input.compileRuns),
    textKernel: await timeCompile(kernelBytes, input.compileRuns),
  };

  const order = [...latin, ...cjk].map((l) => l.id);
  return {
    userAgent: navigator.userAgent,
    lineIds: input.lines.map((l) => l.id),
    shaperOrder: order,
    fontsMs,
    canvas,
    painted,
    harfbuzz: {
      version: hb.version,
      importMs: hb.importMs,
      instantiateMs: hb.instantiateMs,
      memory: hbMem,
      latin: hbLatin,
      cjk: hbCjk,
      wasmBytes: hbBytes.length,
    },
    harfrust: {
      version: hr.name,
      fetchMs,
      compileMs: loaded.compileMs,
      instantiateMs: loaded.instantiateMs,
      memory: hrMem,
      latin: hrLatin,
      cjk: hrCjk,
      wasmBytes: hrBytes.length,
    },
    compile,
  };
}

Object.assign(globalThis, { __s5: { run, ready: true } });
