/**
 * The HarfRust shaper, compiled to WebAssembly from wasm/text-kernel (scripts/build-wasm.ts), as
 * a `Shaper`. The module has no imports and a plain C ABI: input goes into a buffer the module
 * owns (`tk_input`), results come back in another (`tk_output_ptr`, `tk_output_len`).
 */
import { now, webAssembly, type WasmMemory } from '../wasm.ts';
import type { ShapedGlyph, Shaper } from './types.ts';

interface KernelExports {
  memory: WasmMemory;
  tk_input(len: number): number;
  tk_output_ptr(): number;
  tk_output_len(): number;
  tk_font_load(): number;
  tk_font_upem(font: number): number;
  tk_shape(font: number, flags: number): number;
  tk_width(font: number): number;
  tk_break?(): number;
  tk_cache_clear(): void;
  tk_stats(): number;
}

/** The raw module with its font table; `src/kernel/rust.ts` builds on it. */
export class TextKernelModule {
  readonly exports: KernelExports;
  readonly fonts = new Map<string, number>();
  readonly upems = new Map<number, number>();

  constructor(exports: KernelExports) {
    this.exports = exports;
  }

  get memory(): WasmMemory {
    return this.exports.memory;
  }

  /** Copies bytes into the module's input buffer. */
  input(bytes: Uint8Array): void {
    const ptr = this.exports.tk_input(bytes.length);
    new Uint8Array(this.memory.buffer, ptr, bytes.length).set(bytes);
  }

  /** Copies a string into the input buffer as UTF-16LE. */
  inputText(text: string): void {
    const ptr = this.exports.tk_input(text.length * 2);
    const view = new DataView(this.memory.buffer, ptr, text.length * 2);
    for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), true);
  }

  /** A view of the output buffer (valid until the next call into the module). */
  output(): DataView {
    return new DataView(
      this.memory.buffer,
      this.exports.tk_output_ptr(),
      this.exports.tk_output_len(),
    );
  }

  loadFont(id: string, bytes: Uint8Array): number {
    const existing = this.fonts.get(id);
    if (existing !== undefined) return existing;
    this.input(bytes);
    const handle = this.exports.tk_font_load();
    if (handle < 0) throw new Error(`HarfRust could not parse the font ${id}`);
    this.fonts.set(id, handle);
    this.upems.set(handle, this.exports.tk_font_upem(handle));
    return handle;
  }

  handle(id: string): number {
    const h = this.fonts.get(id);
    if (h === undefined) throw new Error(`font ${id} is not loaded`);
    return h;
  }
}

export interface LoadedModule {
  module: TextKernelModule;
  compileMs: number;
  instantiateMs: number;
}

/** Compiles and instantiates the module from its bytes, timing both steps. */
export async function loadTextKernel(bytes: Uint8Array): Promise<LoadedModule> {
  const W = webAssembly();
  if (!W) throw new Error('no WebAssembly in this environment');
  const t0 = now();
  const compiled = await W.compile(bytes.slice());
  const t1 = now();
  const instance = await W.instantiate(compiled, {});
  const t2 = now();
  return {
    module: new TextKernelModule(instance.exports as unknown as KernelExports),
    compileMs: t1 - t0,
    instantiateMs: t2 - t1,
  };
}

/** The `Shaper` view of the module. */
export function harfrustShaper(module: TextKernelModule, name = 'harfrust 0.15.0'): Shaper {
  return {
    name,
    loadFont: (id, bytes) => void module.loadFont(id, bytes),
    upem: (id) => module.upems.get(module.handle(id)) ?? 0,
    shape(id, text, flags = 0): ShapedGlyph[] {
      module.inputText(text);
      const n = module.exports.tk_shape(module.handle(id), flags);
      if (n < 0) throw new Error(`HarfRust could not shape with ${id}`);
      const out = module.output();
      const glyphs: ShapedGlyph[] = [];
      for (let i = 0; i < n; i++)
        glyphs.push({
          glyph: out.getUint32(i * 16, true),
          cluster: out.getUint32(i * 16 + 4, true),
          advance: out.getInt32(i * 16 + 8, true),
          offset: out.getInt32(i * 16 + 12, true),
        });
      return glyphs;
    },
    width(id, text) {
      module.inputText(text);
      return module.exports.tk_width(module.handle(id));
    },
    memoryBytes: () => module.memory.buffer.byteLength,
  };
}
