/**
 * What the layout worker does with a message (WASM-004; 02 §9.1). It owns one kernel instance. This
 * module has no `self` and no `postMessage` of its own: the worker's entry (./layout-worker.ts)
 * gives it the post function and the source of the module, so that a test can run the same code in
 * any realm.
 *
 * - `init`: starts the kernel, from a compiled module the page passes (another worker of the page
 *   compiled it) or from the file at `url`. The answer carries the compiled module back, so the
 *   page can hand it to the next worker instead of compiling again.
 * - `batch`: runs one operation on a batch of whole blocks and answers with one `Uint32Array`, whose
 *   buffer is transferred.
 * - `measure`: shapes the blocks of a batch, one run each, and answers with every code unit's advance
 *   (WASM-006).
 * - `faces`, `release`, `status`: the font faces (WASM-005). The worker fetches the manifest's file
 *   for each face it does not hold, once however many requests ask, and gives the bytes to the
 *   kernel, which refuses a file whose SHA-256 is not the manifest's. Nothing is loaded ahead: a
 *   face that no request names is never fetched. `release` frees an owner's faces or all of them.
 *
 * A trap of the module (or any error in a batch) is caught here and answered as `kernel_trap`; the
 * page then ends this worker. After a trap the instance's memory cannot be trusted, so nothing is
 * run on it again. The document is never here: it lives in the editing core on the page.
 */
import {
  blockBytes,
  blockCount,
  KernelFaceError,
  KernelShapeError,
  type FaceFailure,
  type FaceRequest,
  type FaceStatus,
  type FromWorker,
  type LayoutKernel,
  type ToWorker,
} from '@docedit/layout-kernel';
import { KernelLoadError, loadLayoutKernel, type KernelSource } from './layout-kernel.ts';

export interface WorkerCoreOptions {
  /** The generated module and the URL of its file. */
  source: KernelSource;
  /** Sends a message to the page; the second argument lists the buffers to transfer. */
  post: (message: FromWorker, transfer: ArrayBuffer[]) => void;
  fetch?: typeof fetch;
  /** Milliseconds, monotonic. */
  now?: () => number;
}

/** Builds the handler for the messages of one worker. */
export function createWorkerCore(options: WorkerCoreOptions): (message: ToWorker) => Promise<void> {
  const now = options.now ?? (() => performance.now());
  let kernel: LayoutKernel | null = null;
  let broken = false;

  async function init(message: Extract<ToWorker, { type: 'init' }>): Promise<void> {
    const source: KernelSource =
      message.url === null
        ? options.source
        : { glue: options.source.glue, url: () => message.url as string };
    try {
      const loaded = await loadLayoutKernel({
        source,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        now,
        ...(message.module !== null && message.module !== undefined
          ? { module: message.module }
          : {}),
      });
      kernel = loaded.kernel;
      options.post(
        {
          type: 'ready',
          id: message.id,
          version: loaded.kernel.version,
          abi: loaded.kernel.abi,
          module: loaded.module,
          bytes: loaded.report.bytes,
          streaming: loaded.report.streaming,
          ms: loaded.report.ms ?? 0,
        },
        [],
      );
    } catch (error) {
      const e = error instanceof KernelLoadError ? error : null;
      options.post(
        {
          type: 'error',
          id: message.id,
          code: e?.code ?? 'compile_failed',
          message: error instanceof Error ? error.message : String(error),
          directive: e?.directive ?? null,
          bytes: e?.bytes ?? null,
          streaming: e?.streaming ?? null,
        },
        [],
      );
    }
  }

  function batch(message: Extract<ToWorker, { type: 'batch' }>): void {
    const started = now();
    try {
      if (kernel === null || broken) throw new Error('the kernel is not running');
      const blocks = { text: message.text, offsets: message.offsets };
      const count = blockCount(blocks);
      const values = new Uint32Array(count);
      for (let i = 0; i < count; i++) values[i] = kernel.checksum(blockBytes(blocks, i));
      options.post(
        { type: 'result', id: message.id, values, ms: Math.round((now() - started) * 1000) / 1000 },
        [values.buffer as ArrayBuffer],
      );
    } catch (error) {
      broken = true;
      options.post(
        {
          type: 'error',
          id: message.id,
          code: 'kernel_trap',
          message: error instanceof Error ? error.message : String(error),
          directive: null,
          bytes: null,
          streaming: null,
        },
        [],
      );
    }
  }

  function measure(message: Extract<ToWorker, { type: 'measure' }>): void {
    const started = now();
    const fail = (code: string, text: string): void =>
      options.post(
        {
          type: 'error',
          id: message.id,
          code,
          message: text,
          directive: null,
          bytes: null,
          streaming: null,
        },
        [],
      );
    if (message.offsets.length !== message.runs.length + 1) {
      fail('bad_request', 'a run is needed for each block');
      return;
    }
    try {
      if (kernel === null || broken) throw new Error('the kernel is not running');
      const values = new Int32Array(message.text.length);
      for (let i = 0; i < message.runs.length; i++) {
        const from = message.offsets[i] ?? 0;
        const to = message.offsets[i + 1] ?? from;
        if (to < from || to > message.text.length) throw new RangeError(`block ${i} is outside`);
        values.set(kernel.shaper.advances(message.runs[i]!, message.text.subarray(from, to)), from);
      }
      options.post(
        {
          type: 'advances',
          id: message.id,
          values,
          ms: Math.round((now() - started) * 1000) / 1000,
        },
        [values.buffer as ArrayBuffer],
      );
    } catch (error) {
      // A refused run (an unknown face, a bad feature) is the caller's to fix; anything else is a trap.
      if (error instanceof KernelShapeError) {
        fail(error.code, error.message);
        return;
      }
      broken = true;
      fail('kernel_trap', error instanceof Error ? error.message : String(error));
    }
  }

  // Faces being fetched, by alias, so that two requests for one face fetch it once (WASM-005).
  const loading = new Map<string, Promise<{ outcome: 'new' | 'already' } | FaceFailure>>();

  function status(): FaceStatus {
    const held = kernel;
    return {
      count: held?.faces.count() ?? 0,
      bytesHeld: held?.faces.bytesHeld() ?? 0,
      epoch: held?.faces.epoch() ?? 0,
      memoryBytes: held?.memoryBytes() ?? null,
    };
  }

  /** Fetches one face and gives it to the kernel, which checks it against the manifest's hash. */
  async function loadFace(
    held: LayoutKernel,
    owner: string,
    face: FaceRequest,
  ): Promise<{ outcome: 'new' | 'already' } | FaceFailure> {
    if (held.faces.has(face.alias)) {
      // Held already: the same owner finds it; another owner is refused, and nothing is fetched.
      if (held.faces.owner(face.alias) === owner) return { outcome: 'already' };
      return {
        alias: face.alias,
        code: 'owner_conflict',
        message: 'another owner holds this face; release it first',
      };
    }
    const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
    let bytes: Uint8Array;
    try {
      const response = await doFetch(face.url, { credentials: 'same-origin' });
      if (!response.ok)
        return {
          alias: face.alias,
          code: 'fetch_failed',
          message: `the font file's server answered ${response.status}`,
        };
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      return {
        alias: face.alias,
        code: 'fetch_failed',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    try {
      return { outcome: held.faces.load(owner, face.alias, face.hash, bytes) };
    } catch (error) {
      const code = error instanceof KernelFaceError ? error.code : 'face_failed';
      return {
        alias: face.alias,
        code,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function faces(message: Extract<ToWorker, { type: 'faces' }>): Promise<void> {
    const held = kernel;
    const loaded: string[] = [];
    const already: string[] = [];
    const failed: FaceFailure[] = [];
    if (held === null || broken) {
      for (const face of message.faces)
        failed.push({
          alias: face.alias,
          code: 'kernel_not_running',
          message: 'the kernel is not running',
        });
    } else {
      const results = await Promise.all(
        message.faces.map(async (face) => {
          let pending = loading.get(face.alias);
          if (pending === undefined) {
            pending = loadFace(held, message.owner, face).finally(() => loading.delete(face.alias));
            loading.set(face.alias, pending);
          }
          return [face.alias, await pending] as const;
        }),
      );
      for (const [alias, result] of results) {
        if ('outcome' in result) (result.outcome === 'new' ? loaded : already).push(alias);
        else failed.push(result);
      }
    }
    options.post({ type: 'faces', id: message.id, loaded, already, failed, status: status() }, []);
  }

  function release(message: Extract<ToWorker, { type: 'release' }>): void {
    if (kernel !== null) {
      if (message.owner === null) kernel.faces.releaseAll();
      else kernel.faces.releaseOwner(message.owner);
    }
    options.post({ type: 'status', id: message.id, status: status() }, []);
  }

  return async (message) => {
    switch (message.type) {
      case 'init':
        return init(message);
      case 'batch':
        return batch(message);
      case 'measure':
        return measure(message);
      case 'faces':
        return faces(message);
      case 'release':
        return release(message);
      case 'status':
        options.post({ type: 'status', id: message.id, status: status() }, []);
        return;
    }
  };
}
