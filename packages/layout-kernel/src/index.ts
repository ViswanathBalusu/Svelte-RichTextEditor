/**
 * The layout kernel as a package (ADR 0016; WASM-001). The kernel is the Rust crate of
 * `crates/layout-kernel`, compiled to WebAssembly, passed through wasm-bindgen and wasm-opt and
 * written to `dist/` by `pnpm --filter @docedit/layout-kernel build:wasm`. This module is the
 * TypeScript side: the types of what the module exports and `createKernel`, which starts it.
 *
 * It loads nothing by itself. Fetching the WebAssembly file on demand, inside a worker, with a
 * fallback when the host blocks WebAssembly, is WASM-002 to WASM-004; the caller passes the
 * generated ES module (`@docedit/layout-kernel/wasm/docedit_layout_kernel.js`) and the bytes.
 *
 * Universal: no DOM and no Node.js API (FND-004). The kernel reads no font stack of the system;
 * fonts arrive as bytes from the manifest (WASM-005).
 */

/** The version of the kernel's call interface that this package expects of the crate. */
export const KERNEL_ABI_VERSION = 2;

/** The files that `build:wasm` writes to `dist/`, by role. */
export const KERNEL_FILES = {
  module: 'docedit_layout_kernel.js',
  wasm: 'docedit_layout_kernel_bg.wasm',
  typings: 'docedit_layout_kernel.d.ts',
  record: 'build.json',
} as const;

/** The WebAssembly file as bytes, or an already compiled module that the caller holds. */
export type KernelWasm = Uint8Array | ArrayBuffer;

/** What the generated ES module of wasm-bindgen exports, in the names of the crate. */
export interface KernelGlue {
  /** Compiles and starts the module from bytes, in this thread. */
  initSync(input: { readonly module: KernelWasm }): unknown;
  kernel_version(): string;
  abi_version(): number;
  checksum(data: Uint8Array): number;
  sha256_hex(data: Uint8Array): string;
  face_load(owner: string, alias: string, sha256: string, bytes: Uint8Array): number;
  face_release(alias: string): boolean;
  face_release_owner(owner: string): number;
  face_release_all(): void;
  face_has(alias: string): boolean;
  face_owner(alias: string): string | undefined;
  faces_count(): number;
  faces_bytes_held(): number;
  font_epoch(): number;
}

/** The codes of a refused face (crates/layout-kernel/src/faces.rs). */
export type FaceErrorCode =
  'empty_alias' | 'bad_hash' | 'hash_mismatch' | 'not_a_font' | 'owner_conflict';

/** A face the kernel refused. `code` is the crate's code. */
export class KernelFaceError extends Error {
  override name = 'KernelFaceError';
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/**
 * The font faces a kernel holds (WASM-005; 02 §3, §6). A face is the bytes of one font file, held
 * under an alias (the editor's `de-font-<hash>`) for an owner: the platform's own fonts (the empty
 * string) or one tenant. The kernel checks each file against the manifest's SHA-256 and refuses one
 * that differs. The font epoch counts loads; caches keyed by it miss after a later load.
 */
export interface KernelFaces {
  /** Holds the face. `'new'` advanced the epoch; `'already'` found the same face held. Throws `KernelFaceError`. */
  load(owner: string, alias: string, sha256: string, bytes: Uint8Array): 'new' | 'already';
  release(alias: string): boolean;
  /** Frees every face of one owner; returns how many. */
  releaseOwner(owner: string): number;
  releaseAll(): void;
  has(alias: string): boolean;
  owner(alias: string): string | null;
  count(): number;
  /** The bytes the faces hold. */
  bytesHeld(): number;
  /** The font epoch: the number of faces loaded in this instance. */
  epoch(): number;
}

/** A started kernel. */
export interface LayoutKernel {
  /** The version of the crate that was built. */
  readonly version: string;
  /** The version of the call interface; equals `KERNEL_ABI_VERSION`. */
  readonly abi: number;
  /** The 32-bit FNV-1a hash of the bytes, computed inside the module. */
  checksum(data: Uint8Array): number;
  /** The SHA-256 of the bytes as lowercase hexadecimal, computed inside the module. */
  sha256(data: Uint8Array): string;
  readonly faces: KernelFaces;
  /**
   * The size of the module's linear memory in bytes (faces included), or `null` when the start did
   * not hand it over.
   */
  memoryBytes(): number | null;
}

/**
 * What the generated ES module exports as its default: the asynchronous start. `module_or_path` is
 * a `Response` (compiled with `WebAssembly.instantiateStreaming`), bytes (`WebAssembly.instantiate`)
 * or a compiled module. It is typed `unknown` because this package has no DOM types (FND-004).
 */
export interface KernelGlueModule extends Omit<KernelGlue, 'initSync'> {
  default(input: { module_or_path: unknown }): Promise<unknown>;
}

/** The same as `createKernel`, through the module's asynchronous start (WASM-002). */
export async function startKernel(
  glue: KernelGlueModule,
  moduleOrPath: unknown,
): Promise<LayoutKernel> {
  const output = await glue.default({ module_or_path: moduleOrPath });
  return finishKernel(glue, output);
}

/**
 * Starts the kernel from the generated module and the WebAssembly bytes. Refuses a module whose
 * interface version differs from the one this package expects, so that a stale `dist/` never runs.
 */
export function createKernel(glue: KernelGlue, wasm: KernelWasm): LayoutKernel {
  const output = glue.initSync({ module: wasm });
  return finishKernel(glue, output);
}

/** The exports of a started module, which hold its memory (`output` of the glue's start). */
function memoryOf(output: unknown): { buffer: { byteLength: number } } | null {
  const memory = (output as { memory?: unknown } | null | undefined)?.memory;
  const buffer = (memory as { buffer?: { byteLength?: unknown } } | undefined)?.buffer;
  return typeof buffer?.byteLength === 'number'
    ? (memory as { buffer: { byteLength: number } })
    : null;
}

/** Calls a face function, turning the crate's error into a `KernelFaceError`. */
function faceCall<T>(call: () => T): T {
  try {
    return call();
  } catch (error) {
    throw new KernelFaceError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Checks the interface version of a started module and wraps its calls. `output` is what the
 * glue's start returned (the module's exports); it is only read for the size of the memory.
 */
export function finishKernel(glue: Omit<KernelGlue, 'initSync'>, output?: unknown): LayoutKernel {
  const abi = glue.abi_version();
  if (abi !== KERNEL_ABI_VERSION)
    throw new Error(
      `the layout kernel has interface version ${abi}, this package expects ${KERNEL_ABI_VERSION}`,
    );
  return {
    version: glue.kernel_version(),
    abi,
    checksum: (data) => glue.checksum(data),
    sha256: (data) => glue.sha256_hex(data),
    faces: {
      load: (owner, alias, sha256, bytes) =>
        faceCall(() => glue.face_load(owner, alias, sha256, bytes)) === 1 ? 'new' : 'already',
      release: (alias) => glue.face_release(alias),
      releaseOwner: (owner) => glue.face_release_owner(owner),
      releaseAll: () => glue.face_release_all(),
      has: (alias) => glue.face_has(alias),
      owner: (alias) => glue.face_owner(alias) ?? null,
      count: () => glue.faces_count(),
      bytesHeld: () => glue.faces_bytes_held(),
      epoch: () => glue.font_epoch(),
    },
    memoryBytes: () => memoryOf(output)?.buffer.byteLength ?? null,
  };
}

export * from './batch.ts';
