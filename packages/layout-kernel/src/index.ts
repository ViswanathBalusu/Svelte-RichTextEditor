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
export const KERNEL_ABI_VERSION = 3;

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
  advance_units_per_point(): number;
  shape_advances(
    alias: string,
    size_twips: number,
    language: string,
    features: string,
    text: Uint16Array,
  ): Int32Array;
  shape_width(
    alias: string,
    size_twips: number,
    language: string,
    features: string,
    text: Uint16Array,
  ): number;
  face_line_metrics(alias: string, size_twips: number): Int32Array;
  shape_cache_stats(): Uint32Array;
  shape_cache_clear(): void;
}

/** The codes of a run that was not shaped (crates/layout-kernel/src/shaping.rs). */
export type ShapeErrorCode = 'unknown_face' | 'bad_feature' | 'shape_failed' | 'bad_size';

/** A run the kernel did not shape. `code` is the crate's code. */
export class KernelShapeError extends Error {
  override name = 'KernelShapeError';
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
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

/** What a run is shaped with: the face, the size, the language and the features of the painter. */
export interface RunStyle {
  /** The face's alias (`de-font-<hash>`). */
  readonly alias: string;
  /** The size in twentieths of a point (a whole number, at least 1). */
  readonly sizeTwips: number;
  /** A BCP 47 language tag, or the empty string. */
  readonly language: string;
  /** OpenType features in HarfBuzz syntax, comma separated (`kern=0,liga=0`), or the empty string. */
  readonly features: string;
}

/** Line metrics of a face at a size, in advance units. */
export interface RunLineMetrics {
  readonly ascent: number;
  /** Positive: the depth below the baseline. */
  readonly descent: number;
  readonly lineGap: number;
}

/** What the shaping cache has done (02 §9.3). */
export interface ShapeCacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly entries: number;
  /** The code units of text the cache holds. */
  readonly units: number;
}

/**
 * Shaping and measurement (WASM-006; 02 §9.1, §9.3). An advance is a whole number of
 * `unitsPerPoint` (1280) to the point, which is 64 to the twentieth of a point; it is the font's
 * value scaled to the size and rounded half up in integer arithmetic, so it is the same in every
 * runtime. The advance of a cluster is on its first UTF-16 code unit; the other units of the
 * cluster, and the second unit of a surrogate pair, are 0; the units sum to the run's width.
 */
export interface KernelShaper {
  /** Advance units in one point. */
  readonly unitsPerPoint: number;
  /** The advance of each UTF-16 code unit of `text`. Throws `KernelShapeError`. */
  advances(style: RunStyle, text: string | Uint16Array): Int32Array;
  /** The width of `text`: the sum of `advances`. Throws `KernelShapeError`. */
  width(style: RunStyle, text: string | Uint16Array): number;
  /** The face's ascent, descent and line gap at a size. Throws `KernelShapeError`. */
  lineMetrics(alias: string, sizeTwips: number): RunLineMetrics;
  cacheStats(): ShapeCacheStats;
  clearCache(): void;
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
  readonly shaper: KernelShaper;
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

/** UTF-16 code units of a string, as the kernel reads them. */
export function utf16Units(text: string): Uint16Array {
  const units = new Uint16Array(text.length);
  for (let i = 0; i < text.length; i++) units[i] = text.charCodeAt(i);
  return units;
}

/** Calls a shaping function, turning the crate's error into a `KernelShapeError`. */
function shapeCall<T>(call: () => T): T {
  try {
    return call();
  } catch (error) {
    throw new KernelShapeError(error instanceof Error ? error.message : String(error));
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
    shaper: {
      unitsPerPoint: glue.advance_units_per_point(),
      advances: (s, text) =>
        shapeCall(() =>
          glue.shape_advances(
            s.alias,
            s.sizeTwips,
            s.language,
            s.features,
            typeof text === 'string' ? utf16Units(text) : text,
          ),
        ),
      width: (s, text) =>
        shapeCall(() =>
          glue.shape_width(
            s.alias,
            s.sizeTwips,
            s.language,
            s.features,
            typeof text === 'string' ? utf16Units(text) : text,
          ),
        ),
      lineMetrics: (alias, sizeTwips) => {
        const [ascent = 0, descent = 0, lineGap = 0] = shapeCall(() =>
          glue.face_line_metrics(alias, sizeTwips),
        );
        return { ascent, descent, lineGap };
      },
      cacheStats: () => {
        const [hits = 0, misses = 0, entries = 0, units = 0] = glue.shape_cache_stats();
        return { hits, misses, entries, units };
      },
      clearCache: () => glue.shape_cache_clear(),
    },
    memoryBytes: () => memoryOf(output)?.buffer.byteLength ?? null,
  };
}

export * from './batch.ts';
