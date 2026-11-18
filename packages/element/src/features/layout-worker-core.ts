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
 *
 * A trap of the module (or any error in a batch) is caught here and answered as `kernel_trap`; the
 * page then ends this worker. After a trap the instance's memory cannot be trusted, so nothing is
 * run on it again. The document is never here: it lives in the editing core on the page.
 */
import {
  blockBytes,
  blockCount,
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

  return async (message) => {
    if (message.type === 'init') await init(message);
    else batch(message);
  };
}
