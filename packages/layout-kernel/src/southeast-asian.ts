/**
 * Word-boundary line breaking for Thai, Lao, Khmer and Burmese (WASM-016; 02 §11; owner decision
 * 282). These scripts have no spaces between words, so the rules of UAX #14 give no place to break
 * inside a run of them. The dictionaries of ICU4X do, and they are large: they are in a WebAssembly
 * module of their own (`crates/sea-segmenter`, written to `dist/sea/`), which a page fetches only
 * when a document holds one of the scripts. The layout kernel does not contain them, so the
 * kernel's size budget (WASM-012) is the same for a document that does not use these scripts.
 *
 * Offsets are UTF-16 code units of the block's text (09 §7.1).
 *
 * Universal: no DOM and no Node.js API (FND-004). Fetching the file is the caller's: this module
 * receives a `load` function and calls it at most once, and only after `ensure` has seen text that
 * needs the module.
 */

import type { KernelSegmenter, LineBreakOpportunity } from './segmentation.ts';

/** The version of the module's call interface that this package expects. */
export const SEA_ABI_VERSION = 1;

/** The files that `build:wasm` writes to `dist/sea/`, by role. */
export const SEA_FILES = {
  module: 'sea/docedit_sea_segmenter.js',
  wasm: 'sea/docedit_sea_segmenter_bg.wasm',
  typings: 'sea/docedit_sea_segmenter.d.ts',
  record: 'sea/build.json',
} as const;

/** The Unicode blocks of the four scripts: Thai, Lao, Myanmar and its extensions, Khmer and its symbols. */
const SEA_UNIT = /[฀-໿က-႟ក-៿᧠-᧿ꧠ-꧿ꩠ-ꩿ]/;

/** True when a UTF-16 code unit belongs to Thai, Lao, Khmer or Burmese (as in the crate). */
export function isSoutheastAsianUnit(unit: number): boolean {
  return (
    (unit >= 0x0e00 && unit <= 0x0eff) ||
    (unit >= 0x1000 && unit <= 0x109f) ||
    (unit >= 0x1780 && unit <= 0x17ff) ||
    (unit >= 0x19e0 && unit <= 0x19ff) ||
    (unit >= 0xa9e0 && unit <= 0xa9ff) ||
    (unit >= 0xaa60 && unit <= 0xaa7f)
  );
}

/** True when the text holds a character of Thai, Lao, Khmer or Burmese, so the module is needed. */
export function usesSoutheastAsian(text: string | Uint16Array): boolean {
  if (typeof text === 'string') return SEA_UNIT.test(text);
  for (const unit of text) if (isSoutheastAsianUnit(unit)) return true;
  return false;
}

/** The calls of the generated module of the crate, in its names. */
export interface SeaGlue {
  sea_version(): string;
  sea_abi_version(): number;
  southeast_asian_breaks(text: Uint16Array): Uint32Array;
}

/** What the module's break finder gives. */
export interface SoutheastAsianBreaker {
  /** The version of the crate that was built. */
  readonly version: string;
  /**
   * The offsets inside runs of Thai, Lao, Khmer and Burmese at which a line may break, ascending.
   * The first and last offset of a run are not in the answer: UAX #14 decides those. Text with no
   * such run gives an empty list.
   */
  breaks(text: string | Uint16Array): number[];
}

/** What the generated ES module exports as its default: the asynchronous start. */
export interface SeaGlueModule extends SeaGlue {
  default(input: { module_or_path: unknown }): Promise<unknown>;
}

/** The generated ES module with its synchronous start (Node.js, tests). */
export interface SeaGlueSync extends SeaGlue {
  initSync(input: { readonly module: Uint8Array | ArrayBuffer }): unknown;
}

function unitsOf(text: string | Uint16Array): Uint16Array {
  if (typeof text !== 'string') return text;
  const out = new Uint16Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

/** Wraps a started module. Refuses a module whose interface version is not `SEA_ABI_VERSION`. */
export function breakerOver(glue: SeaGlue): SoutheastAsianBreaker {
  const abi = glue.sea_abi_version();
  if (abi !== SEA_ABI_VERSION)
    throw new Error(
      `the Southeast Asian module has interface version ${abi}, this package expects ${SEA_ABI_VERSION}`,
    );
  return {
    version: glue.sea_version(),
    breaks: (text) => {
      // Text with none of the scripts costs nothing: the module is not called.
      if (!usesSoutheastAsian(text)) return [];
      return Array.from(glue.southeast_asian_breaks(unitsOf(text)));
    },
  };
}

/** Starts the module from its bytes in this thread. */
export function createSoutheastAsian(
  glue: SeaGlueSync,
  wasm: Uint8Array | ArrayBuffer,
): SoutheastAsianBreaker {
  glue.initSync({ module: wasm });
  return breakerOver(glue);
}

/** Starts the module through its asynchronous start; `moduleOrPath` is a `Response`, bytes or a module. */
export async function startSoutheastAsian(
  glue: SeaGlueModule,
  moduleOrPath: unknown,
): Promise<SoutheastAsianBreaker> {
  await glue.default({ module_or_path: moduleOrPath });
  return breakerOver(glue);
}

/** Merges two ascending lists of offsets, once each. */
function mergeOffsets(a: readonly number[], b: readonly number[]): number[] {
  const out: number[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const x = a[i] ?? Infinity;
    const y = b[j] ?? Infinity;
    const next = Math.min(x, y);
    if (out[out.length - 1] !== next) out.push(next);
    if (x === next) i++;
    if (y === next) j++;
  }
  return out;
}

/**
 * A segmenter that also breaks inside runs of Thai, Lao, Khmer and Burmese, with the breaker's
 * offsets added to the kernel's. Everything else is the kernel's own answer. The result is the
 * same kind of `KernelSegmenter`, so the layout engine takes it where it took the kernel's.
 */
export function withSoutheastAsian(
  segmenter: KernelSegmenter,
  breaker: SoutheastAsianBreaker,
): KernelSegmenter {
  return {
    unicode: segmenter.unicode,
    lineBreaks: (text, language) => {
      const base = segmenter.lineBreaks(text, language);
      const extra = breaker.breaks(text);
      if (extra.length === 0) return base;
      const known = new Set(base.map((b) => b.offset));
      const merged: LineBreakOpportunity[] = [...base];
      for (const offset of extra) if (!known.has(offset)) merged.push({ offset, mandatory: false });
      return merged.sort((p, q) => p.offset - q.offset);
    },
    opportunities: (text, language) =>
      mergeOffsets(segmenter.opportunities(text, language), breaker.breaks(text)),
    graphemeBoundaries: (text) => segmenter.graphemeBoundaries(text),
  };
}

/**
 * The module as a page uses it: loaded on demand. `ensure` is given the texts of a document (or
 * of the paragraphs about to be laid out); it calls `load` the first time one of them holds a
 * character of these scripts, and never for a document that has none. The call is made once: later
 * calls wait for the same promise, and a failed load may be tried again.
 */
export interface LazySoutheastAsian {
  /** True once the module is started. */
  readonly loaded: boolean;
  /** True when `load` has been called, finished or not. */
  readonly requested: boolean;
  /** Loads the module when a text needs it. Resolves to true when it is loaded. */
  ensure(texts: Iterable<string | Uint16Array>): Promise<boolean>;
  /** The segmenter: the kernel's, plus the breaker's offsets once the module is loaded. */
  segmenter(base: KernelSegmenter): KernelSegmenter;
  /** Drops the module, so that the next document that needs it loads it again. */
  release(): void;
}

/** Makes the on-demand holder of the module. `load` fetches and starts it. */
export function lazySoutheastAsian(load: () => Promise<SoutheastAsianBreaker>): LazySoutheastAsian {
  let breaker: SoutheastAsianBreaker | null = null;
  let pending: Promise<SoutheastAsianBreaker> | null = null;
  let epoch = 0;
  return {
    get loaded() {
      return breaker !== null;
    },
    get requested() {
      return pending !== null;
    },
    async ensure(texts) {
      if (breaker !== null) return true;
      if (pending === null) {
        let needed = false;
        for (const text of texts) {
          if (usesSoutheastAsian(text)) {
            needed = true;
            break;
          }
        }
        if (!needed) return false;
        const generation = epoch;
        pending = load().then(
          (b) => {
            // A `release` while the load ran makes this answer stale.
            if (generation === epoch) breaker = b;
            return b;
          },
          (error: unknown) => {
            if (generation === epoch) pending = null;
            throw error;
          },
        );
      }
      await pending;
      return true;
    },
    segmenter: (base) => {
      const holder: { current: KernelSegmenter | null; from: SoutheastAsianBreaker | null } = {
        current: null,
        from: null,
      };
      // Chosen at each call, so that a segmenter made before the load starts to break after it.
      const pick = (): KernelSegmenter => {
        if (breaker === null) return base;
        if (holder.from !== breaker || holder.current === null) {
          holder.current = withSoutheastAsian(base, breaker);
          holder.from = breaker;
        }
        return holder.current;
      };
      return {
        unicode: base.unicode,
        lineBreaks: (text, language) => pick().lineBreaks(text, language),
        opportunities: (text, language) => pick().opportunities(text, language),
        graphemeBoundaries: (text) => base.graphemeBoundaries(text),
      };
    },
    release() {
      epoch++;
      breaker = null;
      pending = null;
    },
  };
}
