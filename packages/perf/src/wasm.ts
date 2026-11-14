/**
 * Structural types for the WebAssembly and clock globals that the measurement code uses. The
 * package's universal code keeps lib ES2023 with no ambient types (FND-004), which declare
 * neither `WebAssembly` nor `performance`; both exist in Node.js 22, in browsers and in workers.
 */

export interface WasmMemory {
  readonly buffer: ArrayBuffer;
}

/** An opaque compiled module. */
export interface WasmModule {
  readonly __wasmModule?: never;
}

export interface WasmInstance {
  readonly exports: Readonly<Record<string, unknown>>;
}

export interface WasmImportDescriptor {
  readonly module: string;
  readonly name: string;
  readonly kind: 'function' | 'memory' | 'table' | 'global' | 'tag';
}

export interface WasmApi {
  compile(bytes: Uint8Array | ArrayBuffer): Promise<WasmModule>;
  instantiate(module: WasmModule, imports?: object): Promise<WasmInstance>;
  validate(bytes: Uint8Array | ArrayBuffer): boolean;
  readonly Module: {
    imports(module: WasmModule): WasmImportDescriptor[];
  };
  readonly Memory: new (descriptor: { initial: number; maximum?: number }) => WasmMemory;
  readonly Table: new (descriptor: {
    initial: number;
    element: 'anyfunc' | 'externref';
  }) => unknown;
}

/** The global `WebAssembly`, or null where the host has none. */
export function webAssembly(): WasmApi | null {
  return (globalThis as unknown as { WebAssembly?: WasmApi }).WebAssembly ?? null;
}

/** A monotonic clock in milliseconds (`performance.now()`). */
export function now(): number {
  return (globalThis as unknown as { performance: { now(): number } }).performance.now();
}

/**
 * Compiles and instantiates a module `runs` times from its bytes, with stub imports, and returns
 * each run's compile and instantiate time in milliseconds. Each compile starts from a fresh copy
 * of the bytes. An engine may still reuse compiled code within the page, so the first run is the
 * one to quote as a cold compile; the later runs show the spread.
 */
export async function timeCompile(
  bytes: Uint8Array,
  runs: number,
): Promise<{ compileMs: number[]; instantiateMs: number[] }> {
  const W = webAssembly();
  if (!W) throw new Error('no WebAssembly in this environment');
  const compileMs: number[] = [];
  const instantiateMs: number[] = [];
  for (let i = 0; i < runs; i++) {
    const copy = bytes.slice();
    const t0 = now();
    const module = await W.compile(copy);
    const t1 = now();
    await W.instantiate(module, stubImports(W, module));
    const t2 = now();
    compileMs.push(t1 - t0);
    instantiateMs.push(t2 - t1);
  }
  return { compileMs, instantiateMs };
}

/** Imports that satisfy a module's import list without doing anything (for timing only). */
export function stubImports(
  W: WasmApi,
  module: WasmModule,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const imp of W.Module.imports(module)) {
    const ns = (out[imp.module] ??= {});
    if (imp.kind === 'function') ns[imp.name] = () => 0;
    else if (imp.kind === 'memory') ns[imp.name] = new W.Memory({ initial: 256 });
    else if (imp.kind === 'table') ns[imp.name] = new W.Table({ initial: 0, element: 'anyfunc' });
  }
  return out;
}
