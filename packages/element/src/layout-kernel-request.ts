/**
 * The core's only way to the layout kernel (WASM-002, WASM-004; ADR 0016). Nothing here imports the
 * kernel, its loader or the worker's host statically: `ElementKernel` loads them on first use, so a
 * session that only uses the web view fetches and compiles no WebAssembly, and the first
 * interactive chunk holds none (FND-008 fails the build otherwise; critical-path.test.ts).
 *
 * Each editor element has one `ElementKernel`, which owns at most one layout worker, which owns one
 * kernel instance. The page compiles nothing: the first worker of the page fetches and compiles the
 * WebAssembly file and hands the compiled module back, and every later worker (a second editor, or
 * the same editor after a suspend) starts from that module (`pageModule`).
 *
 * Lifecycle (02 §2.1): `stop` ends the worker (the element suspends); the next use creates it
 * again; `destroy` ends it for good. A trap of the kernel ends the worker, is reported to the host
 * through `de-diagnostic`, and rejects the batch that met it. The document lives in the editing
 * core on this thread, so nothing is lost.
 */
import type { BatchOperation, BlockBatch, FaceRequest, FaceStatus } from '@docedit/layout-kernel';
import type { DiagnosticDetail } from './events.ts';
import type {
  BatchStat,
  FacesResult,
  LayoutWorker,
  LayoutWorkerError,
  WorkerLike,
} from './features/layout-worker-host.ts';

/** What `ElementKernel` loads on first use: the host's class and the way to make a worker. */
export interface WorkerHostModule {
  LayoutWorker: typeof LayoutWorker;
  create: () => WorkerLike;
}

export interface RequestOptions {
  /** Replaceable for tests: the chunk of the worker's host. */
  load?: () => Promise<WorkerHostModule>;
  /** Milliseconds, monotonic. Replaceable for tests. */
  now?: () => number;
}

const failure = (
  code: string,
  extra: Partial<Pick<DiagnosticDetail, 'directive' | 'bytes' | 'streaming'>> = {},
): DiagnosticDetail => ({
  feature: 'layout-kernel',
  kind: 'load-failed',
  ms: null,
  bytes: extra.bytes ?? null,
  streaming: extra.streaming ?? null,
  code,
  directive: extra.directive ?? null,
  fallback: null,
});

/** The compiled module of this page, once a worker has made it (or while one is). */
let pageModule: Promise<unknown> | null = null;

async function defaultLoad(): Promise<WorkerHostModule> {
  const [host, { createLayoutWorker }] = await Promise.all([
    import('./features/layout-worker-host.ts'),
    import('./features/layout-worker-create.ts'),
  ]);
  return { LayoutWorker: host.LayoutWorker, create: createLayoutWorker };
}

/** How many batch records an element keeps across restarts of its worker. */
const HISTORY_LIMIT = 256;

export class ElementKernel {
  readonly #report: (detail: DiagnosticDetail) => void;
  readonly #options: RequestOptions;
  #worker: LayoutWorker | null = null;
  #starting: Promise<LayoutWorker | null> | null = null;
  #generation = 0;
  #destroyed = false;
  #history: BatchStat[] = [];

  constructor(report: (detail: DiagnosticDetail) => void, options: RequestOptions = {}) {
    this.#report = report;
    this.#options = options;
  }

  /** True while a worker is running. */
  get running(): boolean {
    return this.#worker?.alive === true;
  }

  /** The cost records of the batches this element ran, oldest first. */
  get stats(): readonly BatchStat[] {
    return [...this.#history, ...(this.#worker?.stats ?? [])];
  }

  /**
   * Starts the worker if none runs, and reports how it went. Resolves to whether a worker runs; it
   * never rejects, because the report has described a failure.
   */
  async start(): Promise<boolean> {
    return (await this.#ensure()) !== null;
  }

  /**
   * Runs one operation on whole blocks, starting the worker first if it was stopped. Rejects when no
   * worker can run (the failure has been reported) or when the kernel traps (also reported).
   */
  async batch(op: BatchOperation, blocks: readonly string[] | BlockBatch): Promise<Uint32Array> {
    const worker = await this.#ensure();
    if (worker === null)
      throw Object.assign(new Error('the layout kernel is not available'), {
        code: 'kernel_unavailable',
      });
    return worker.batch(op, blocks);
  }

  /**
   * Holds these font files in the kernel for `owner` (WASM-005), starting the worker if it was
   * stopped. Only the files named are fetched, once each for this worker; a file whose hash is not
   * the manifest's is refused and listed in `failed`. Rejects when no worker can run.
   */
  async ensureFaces(owner: string, faces: readonly FaceRequest[]): Promise<FacesResult> {
    return (await this.#running()).ensureFaces(owner, faces);
  }

  /** Frees one owner's faces (`owner`), or every face (`null`). */
  async releaseFaces(owner: string | null): Promise<FaceStatus> {
    return (await this.#running()).releaseFaces(owner);
  }

  /** What the worker holds for faces and how large its memory is. */
  async status(): Promise<FaceStatus> {
    return (await this.#running()).status();
  }

  async #running(): Promise<LayoutWorker> {
    const worker = await this.#ensure();
    if (worker === null)
      throw Object.assign(new Error('the layout kernel is not available'), {
        code: 'kernel_unavailable',
      });
    return worker;
  }

  /** The element suspends: the worker ends. The next `start` or `batch` creates it again. */
  stop(): void {
    this.#generation++;
    this.#release();
  }

  /** The element is destroyed: the worker and its memory are released, for good. */
  destroy(): void {
    this.#destroyed = true;
    this.stop();
  }

  #release(): void {
    const worker = this.#worker;
    this.#worker = null;
    this.#starting = null;
    if (worker === null) return;
    this.#history = [...this.#history, ...worker.stats].slice(-HISTORY_LIMIT);
    worker.terminate();
  }

  #ensure(): Promise<LayoutWorker | null> {
    if (this.#destroyed) return Promise.resolve(null);
    if (this.#worker?.alive === true) return Promise.resolve(this.#worker);
    this.#starting ??= this.#create(this.#generation);
    return this.#starting;
  }

  async #create(generation: number): Promise<LayoutWorker | null> {
    const now = this.#options.now ?? (() => performance.now());
    const started = now();
    let host: WorkerHostModule;
    try {
      host = await (this.#options.load ?? defaultLoad)();
    } catch (error) {
      return this.#abandon(generation, failure('chunk_failed'), error);
    }
    if (generation !== this.#generation) return null;

    // The first worker of the page compiles; the others wait for its module and reuse it.
    let owner: { resolve(m: unknown): void; reject(e: unknown): void } | null = null;
    let reused: unknown;
    if (pageModule !== null) {
      try {
        reused = await pageModule;
      } catch {
        reused = undefined;
      }
    } else {
      pageModule = new Promise<unknown>((resolve, reject) => {
        owner = { resolve, reject };
      });
      pageModule.catch(() => {});
    }
    const mine = pageModule;
    const ownerOf = owner as { resolve(m: unknown): void; reject(e: unknown): void } | null;

    try {
      const { worker, ready } = await host.LayoutWorker.start({
        create: host.create,
        ...(reused !== undefined ? { module: reused } : {}),
        now,
      });
      ownerOf?.resolve(ready.module);
      if (generation !== this.#generation) {
        worker.terminate();
        return null;
      }
      worker.onFailure((error) => this.#onWorkerFailure(worker, error));
      this.#worker = worker;
      this.#starting = null;
      this.#report({
        feature: 'layout-kernel',
        kind: 'loaded',
        ms: Math.round((now() - started) * 10) / 10,
        bytes: ready.bytes,
        streaming: ready.streaming,
        code: null,
        directive: null,
        fallback: null,
      });
      return worker;
    } catch (error) {
      if (ownerOf !== null) {
        if (pageModule === mine) pageModule = null;
        ownerOf.reject(error);
      }
      const e = error as Partial<LayoutWorkerError>;
      return this.#abandon(
        generation,
        failure(typeof e.code === 'string' ? e.code : 'compile_failed', {
          directive: typeof e.directive === 'string' ? e.directive : null,
          bytes: typeof e.bytes === 'number' ? e.bytes : null,
          streaming: typeof e.streaming === 'boolean' ? e.streaming : null,
        }),
        error,
      );
    }
  }

  /** A start that did not work: reports it unless the element moved on, and lets a later call retry. */
  #abandon(generation: number, detail: DiagnosticDetail, _cause: unknown): null {
    if (generation === this.#generation) {
      this.#starting = null;
      this.#report(detail);
    }
    return null;
  }

  /** The kernel trapped, or the worker died: the view falls back (the owner hears it). */
  #onWorkerFailure(worker: LayoutWorker, error: LayoutWorkerError): void {
    if (this.#worker !== worker) return;
    this.#history = [...this.#history, ...worker.stats].slice(-HISTORY_LIMIT);
    this.#worker = null;
    this.#starting = null;
    this.#report(failure(error.code));
  }
}

/**
 * Starts the layout kernel for one element and tells `report` how it went: the time the worker took
 * to be ready, or why it failed and which directive the host lacks. Resolves to the element's kernel
 * (which keeps its own lifecycle), whatever happened; `report` carries a failure.
 */
export async function requestLayoutKernel(
  report: (detail: DiagnosticDetail) => void,
  options: RequestOptions = {},
): Promise<ElementKernel> {
  const kernel = new ElementKernel(report, options);
  await kernel.start();
  return kernel;
}

/** Forgets the page's compiled module. For tests. */
export function resetLayoutKernelRequests(): void {
  pageModule = null;
}
