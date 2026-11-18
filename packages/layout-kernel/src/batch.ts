/**
 * What crosses the boundary between the page and the layout worker (WASM-004; 02 §9.1).
 *
 * A request is a batch of whole blocks: every block's text as UTF-16 code units in one
 * `Uint16Array`, and the block boundaries as one `Uint32Array` of `blocks + 1` offsets into it.
 * A result is one `Uint32Array`, a value for each block. Both are typed arrays whose buffers are
 * transferred, never copied. No `SharedArrayBuffer` is used, so the host page need not be
 * cross-origin isolated.
 *
 * The only operation the crate has today is `checksum`, the 32-bit FNV-1a hash of a block's code
 * units (each as two bytes, low byte first, whatever the platform's byte order). The operations of
 * shaping and line breaking (WASM-006, WASM-008) add names to `BatchOperation` and nothing else to
 * this shape.
 *
 * Universal: no DOM and no Node.js API (FND-004).
 */

/** The operations a batch can ask for. */
export type BatchOperation = 'checksum';

/** Whole blocks, packed. `offsets[i]..offsets[i + 1]` are the code units of block `i`. */
export interface BlockBatch {
  readonly text: Uint16Array;
  readonly offsets: Uint32Array;
}

/** Packs block texts into a batch. */
export function packBlocks(blocks: readonly string[]): BlockBatch {
  let total = 0;
  for (const block of blocks) total += block.length;
  const text = new Uint16Array(total);
  const offsets = new Uint32Array(blocks.length + 1);
  let at = 0;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    for (let j = 0; j < block.length; j++) text[at + j] = block.charCodeAt(j);
    at += block.length;
    offsets[i + 1] = at;
  }
  return { text, offsets };
}

/** The number of blocks in a batch. */
export function blockCount(batch: BlockBatch): number {
  return Math.max(0, batch.offsets.length - 1);
}

/** A batch's code units for one block, as the bytes the kernel reads (low byte first). */
export function blockBytes(batch: BlockBatch, index: number): Uint8Array {
  const from = batch.offsets[index];
  const to = batch.offsets[index + 1];
  if (from === undefined || to === undefined || to < from || to > batch.text.length)
    throw new RangeError(`block ${index} is outside the batch`);
  const bytes = new Uint8Array((to - from) * 2);
  for (let i = from; i < to; i++) {
    const unit = batch.text[i]!;
    bytes[(i - from) * 2] = unit & 0xff;
    bytes[(i - from) * 2 + 1] = unit >> 8;
  }
  return bytes;
}

/** One font file the worker may be asked to hold: the editor's alias, where it is served, its hash. */
export interface FaceRequest {
  /** The alias the editor registers the file under (`de-font-<hash>`). */
  readonly alias: string;
  /** The manifest's URL for the file: the one the FontFace API and the LaTeX workers load. */
  readonly url: string;
  /** The manifest's SHA-256 of the file, lowercase hexadecimal. */
  readonly hash: string;
}

/** What the worker holds for faces (WASM-005). */
export interface FaceStatus {
  /** The number of faces held. */
  readonly count: number;
  /** The bytes the faces hold. */
  readonly bytesHeld: number;
  /** The font epoch: the faces loaded so far in this worker. */
  readonly epoch: number;
  /** The kernel's whole linear memory, faces included; `null` when unknown. */
  readonly memoryBytes: number | null;
}

/** Messages from the page to the worker. `id` pairs a request with its answer. */
export type ToWorker =
  | {
      /** Loads the faces of `faces` that are not held yet, for `owner`: `''` is the platform's fonts. */
      readonly type: 'faces';
      readonly id: number;
      readonly owner: string;
      readonly faces: readonly FaceRequest[];
    }
  | {
      /** Frees the faces of `owner`, or every face when `owner` is `null`. */
      readonly type: 'release';
      readonly id: number;
      readonly owner: string | null;
    }
  | { readonly type: 'status'; readonly id: number }
  | {
      readonly type: 'init';
      readonly id: number;
      /** A compiled module another worker of the page made (reused), or `null` to fetch `url`. */
      readonly module: unknown;
      readonly url: string | null;
    }
  | {
      readonly type: 'batch';
      readonly id: number;
      readonly op: BatchOperation;
      readonly text: Uint16Array;
      readonly offsets: Uint32Array;
    };

/** A face that was not loaded, with the code of the cause. */
export interface FaceFailure {
  readonly alias: string;
  /** `fetch_failed`, or a code of the kernel (`hash_mismatch`, `not_a_font`, `owner_conflict`, …). */
  readonly code: string;
  readonly message: string;
}

/** Messages from the worker to the page. */
export type FromWorker =
  | {
      readonly type: 'faces';
      readonly id: number;
      /** Aliases loaded by this request. */
      readonly loaded: readonly string[];
      /** Aliases that were held already (or that another request was loading). */
      readonly already: readonly string[];
      readonly failed: readonly FaceFailure[];
      readonly status: FaceStatus;
    }
  | { readonly type: 'status'; readonly id: number; readonly status: FaceStatus }
  | {
      readonly type: 'ready';
      readonly id: number;
      readonly version: string;
      readonly abi: number;
      /** The compiled module, for the page to hand to the next worker. */
      readonly module: unknown;
      readonly bytes: number | null;
      readonly streaming: boolean | null;
      /** Milliseconds the worker spent on the start. */
      readonly ms: number;
    }
  | {
      readonly type: 'result';
      readonly id: number;
      readonly values: Uint32Array;
      /** Milliseconds the worker spent on the batch (its own clock). */
      readonly ms: number;
    }
  | {
      readonly type: 'error';
      readonly id: number;
      /** A code of `DiagnosticDetail`, or `kernel_trap` for a trap inside a batch. */
      readonly code: string;
      readonly message: string;
      readonly directive: string | null;
      readonly bytes: number | null;
      readonly streaming: boolean | null;
    };
