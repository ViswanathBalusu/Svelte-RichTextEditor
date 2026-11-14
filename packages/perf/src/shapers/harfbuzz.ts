/**
 * HarfBuzz's own WebAssembly build (harfbuzzjs 1.6.1) as a `Shaper`.
 *
 * harfbuzzjs instantiates its module when it is first imported and keeps the instance private.
 * To time that step and to read the module's memory, `loadHarfbuzz` wraps the global
 * `WebAssembly.instantiate` and `instantiateStreaming` during the import and restores them
 * afterwards; nothing else is changed.
 */
import type * as HarfBuzzModule from 'harfbuzzjs';
import { now, type WasmInstance, type WasmMemory } from '../wasm.ts';
import { NO_KERN, NO_LIGA, type ShapedGlyph, type Shaper } from './types.ts';

type HarfBuzz = typeof HarfBuzzModule;

export interface LoadedHarfbuzz {
  hb: HarfBuzz;
  shaper: Shaper;
  /** From the start of the dynamic import to its end: fetch, compile, instantiate, set-up. */
  importMs: number;
  /** Time inside `WebAssembly.instantiate` or `instantiateStreaming` (compile and instantiate). */
  instantiateMs: number;
  version: string;
}

interface InstantiateResult {
  instance?: WasmInstance;
  exports?: unknown;
}

type Instantiate = (...args: unknown[]) => Promise<InstantiateResult>;

export async function loadHarfbuzz(): Promise<LoadedHarfbuzz> {
  const W = (globalThis as unknown as { WebAssembly: Record<string, unknown> }).WebAssembly;
  const original = { instantiate: W['instantiate'], streaming: W['instantiateStreaming'] };
  let memory: WasmMemory | null = null;
  let instantiateMs = 0;
  const wrap =
    (fn: Instantiate): Instantiate =>
    async (...args) => {
      const t = now();
      const result = await fn.apply(W, args);
      instantiateMs += now() - t;
      const exports = (result.instance?.exports ?? result.exports) as Record<string, unknown>;
      if (exports && typeof exports['memory'] === 'object')
        memory = exports['memory'] as WasmMemory;
      return result;
    };
  W['instantiate'] = wrap(original.instantiate as Instantiate);
  if (typeof original.streaming === 'function')
    W['instantiateStreaming'] = wrap(original.streaming as Instantiate);
  const t0 = now();
  let hb: HarfBuzz;
  try {
    hb = await import('harfbuzzjs');
  } finally {
    W['instantiate'] = original.instantiate;
    if (typeof original.streaming === 'function') W['instantiateStreaming'] = original.streaming;
  }
  const importMs = now() - t0;
  const mem = memory as WasmMemory | null;
  const version = `harfbuzzjs 1.6.1 (HarfBuzz ${hb.versionString()})`;
  return {
    hb,
    shaper: harfbuzzShaper(hb, () => mem?.buffer.byteLength ?? 0, version),
    importMs,
    instantiateMs,
    version,
  };
}

interface HbFont {
  font: InstanceType<HarfBuzz['Font']>;
  upem: number;
}

export function harfbuzzShaper(hb: HarfBuzz, memoryBytes: () => number, name: string): Shaper {
  const fonts = new Map<string, HbFont>();
  const noKern = [new hb.Feature('kern', 0)];
  const noLiga = [new hb.Feature('liga', 0), new hb.Feature('clig', 0)];
  const get = (id: string): HbFont => {
    const f = fonts.get(id);
    if (!f) throw new Error(`font ${id} is not loaded`);
    return f;
  };
  // One buffer, reset before each use: harfbuzzjs frees buffers only when the garbage collector
  // finalises them, so a new buffer per call would grow the module's memory until a collection.
  const buffer = new hb.Buffer();
  const run = (id: string, text: string, flags: number): ShapedGlyph[] => {
    const { font } = get(id);
    buffer.reset();
    buffer.addText(text);
    buffer.guessSegmentProperties();
    const features = [...(flags & NO_KERN ? noKern : []), ...(flags & NO_LIGA ? noLiga : [])];
    hb.shape(font, buffer, features);
    const infos = buffer.getGlyphInfos();
    const positions = buffer.getGlyphPositions();
    const out: ShapedGlyph[] = [];
    for (let i = 0; i < infos.length; i++)
      out.push({
        glyph: infos[i]!.codepoint,
        cluster: infos[i]!.cluster,
        advance: positions[i]!.xAdvance,
        offset: positions[i]!.xOffset,
      });
    return out;
  };
  return {
    name,
    loadFont(id, bytes) {
      if (fonts.has(id)) return;
      const face = new hb.Face(new hb.Blob(bytes), 0);
      fonts.set(id, { font: new hb.Font(face), upem: face.upem });
    },
    upem: (id) => get(id).upem,
    shape: (id, text, flags = 0) => run(id, text, flags),
    width(id, text) {
      let w = 0;
      for (const g of run(id, text, 0)) w += g.advance;
      return w;
    },
    memoryBytes,
  };
}
