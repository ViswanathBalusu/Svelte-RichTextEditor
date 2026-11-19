/**
 * The page's side of the layout worker (WASM-004; 02 §9.1, §9.5). This module is a lazy chunk of its
 * own, reached only through `requestLayoutKernel` (../layout-kernel-request.ts).
 *
 * `LayoutWorker` is one worker with a narrow interface: `start` (once), `batch` (any number of
 * times) and `terminate`. A batch is a set of whole blocks. Its typed arrays are transferred, so the
 * caller's arrays are empty afterwards, and the answer's array is transferred back. For every batch
 * the host records what it cost (`BatchStat`): the worker's own time and the round trip.
 *
 * The worker is created by a function the caller gives (`create`), so a test can run the same code
 * on any worker (`createLayoutWorker` of ./layout-worker-create.ts is the build's own). No
 * `SharedArrayBuffer` is used (the page need not be cross-origin isolated).
 */
import {
  packBlocks,
  type BatchOperation,
  type BlockBatch,
  type FaceRequest,
  type MeasureRun,
  type FaceStatus,
  type FromWorker,
  type ToWorker,
} from '@docedit/layout-kernel';

/** The part of `Worker` the host uses. */
export interface WorkerLike {
  postMessage(message: ToWorker, transfer: ArrayBuffer[]): void;
  terminate(): void;
  onmessage: ((event: { data: FromWorker }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
  onmessageerror?: (() => void) | null;
}

/** What one batch cost. Times are milliseconds on the clocks of each side. */
export interface BatchStat {
  readonly op: BatchOperation;
  readonly blocks: number;
  /** UTF-16 code units sent. */
  readonly units: number;
  /** The worker's time in the call (its clock). */
  readonly workerMs: number;
  /** From the post to the answer (the page's clock). */
  readonly roundTripMs: number;
}

/** How many batch records are kept. */
export const STAT_LIMIT = 256;

/** A worker that did not start, or that stopped: the code is one of `DiagnosticDetail`'s. */
export class LayoutWorkerError extends Error {
  override name = 'LayoutWorkerError';
  readonly code: string;
  readonly directive: string | null;
  readonly bytes: number | null;
  readonly streaming: boolean | null;
  constructor(
    code: string,
    message: string,
    extra: { directive?: string | null; bytes?: number | null; streaming?: boolean | null } = {},
  ) {
    super(message);
    this.code = code;
    this.directive = extra.directive ?? null;
    this.bytes = extra.bytes ?? null;
    this.streaming = extra.streaming ?? null;
  }
}

export interface StartOptions {
  /** Makes the worker. */
  create: () => WorkerLike;
  /** A compiled module of this page; the worker then compiles nothing. */
  module?: unknown;
  /** Replaces the kernel's own file URL (tests); normally `null`, the worker knows it. */
  url?: string | null;
  now?: () => number;
}

export type Ready = Extract<FromWorker, { type: 'ready' }>;

/** What a request for faces did. */
export type FacesResult = Extract<FromWorker, { type: 'faces' }>;

interface Pending {
  resolve(message: FromWorker): void;
  reject(error: Error): void;
}

export class LayoutWorker {
  readonly #worker: WorkerLike;
  readonly #now: () => number;
  readonly #pending = new Map<number, Pending>();
  readonly #stats: BatchStat[] = [];
  #next = 1;
  #dead: LayoutWorkerError | null = null;
  #onFailure: ((error: LayoutWorkerError) => void) | null = null;
  /** The compiled module this worker started from, for the next worker of the page. */
  module: unknown = null;

  private constructor(worker: WorkerLike, now: () => number) {
    this.#worker = worker;
    this.#now = now;
    worker.onmessage = (event) => this.#receive(event.data);
    worker.onerror = (event) =>
      this.#fail(
        new LayoutWorkerError('worker_failed', event.message ?? 'the layout worker failed'),
      );
    worker.onmessageerror = () =>
      this.#fail(new LayoutWorkerError('worker_failed', 'a message to the worker was not read'));
  }

  /** Starts a worker and its kernel. Rejects with `LayoutWorkerError`; never leaves a worker running. */
  static async start(options: StartOptions): Promise<{ worker: LayoutWorker; ready: Ready }> {
    let raw: WorkerLike;
    try {
      raw = options.create();
    } catch (error) {
      throw new LayoutWorkerError(
        'worker_failed',
        `the layout worker could not be created: ${text(error)}`,
      );
    }
    const worker = new LayoutWorker(raw, options.now ?? (() => performance.now()));
    try {
      const answer = await worker.#request({
        type: 'init',
        id: 0,
        module: options.module ?? null,
        url: options.url ?? null,
      });
      if (answer.type === 'error')
        throw new LayoutWorkerError(answer.code, answer.message, {
          directive: answer.directive,
          bytes: answer.bytes,
          streaming: answer.streaming,
        });
      if (answer.type !== 'ready')
        throw new LayoutWorkerError('worker_failed', 'the layout worker answered out of turn');
      worker.module = answer.module;
      return { worker, ready: answer };
    } catch (error) {
      worker.terminate();
      throw error instanceof LayoutWorkerError
        ? error
        : new LayoutWorkerError('worker_failed', text(error));
    }
  }

  /** Called once if the worker fails after it has started (a trap, or an error of the worker). */
  onFailure(callback: (error: LayoutWorkerError) => void): void {
    this.#onFailure = callback;
  }

  get alive(): boolean {
    return this.#dead === null;
  }

  /** The records of the last batches, oldest first. */
  get stats(): readonly BatchStat[] {
    return this.#stats;
  }

  /**
   * Runs one operation on whole blocks. The arrays of a `BlockBatch` are transferred and are empty
   * afterwards; a list of strings is packed first. Resolves to one value for each block.
   */
  async batch(op: BatchOperation, blocks: readonly string[] | BlockBatch): Promise<Uint32Array> {
    const packed = Array.isArray(blocks)
      ? packBlocks(blocks as readonly string[])
      : (blocks as BlockBatch);
    const count = Math.max(0, packed.offsets.length - 1);
    const units = packed.text.length;
    const started = this.#now();
    const answer = await this.#request({
      type: 'batch',
      id: 0,
      op,
      text: packed.text,
      offsets: packed.offsets,
    });
    if (answer.type !== 'result')
      throw new LayoutWorkerError('kernel_trap', 'the layout worker answered out of turn');
    this.#stats.push({
      op,
      blocks: count,
      units,
      workerMs: answer.ms,
      roundTripMs: Math.round((this.#now() - started) * 1000) / 1000,
    });
    if (this.#stats.length > STAT_LIMIT) this.#stats.shift();
    return answer.values;
  }

  /**
   * Shapes each block as one run (`runs[i]` for block `i`) and returns the advance of every code
   * unit, in advance units, in the order of the blocks' text. The arrays of a `BlockBatch` are
   * transferred. A refused run (an unknown face) rejects with its code and does not end the worker.
   */
  async measure(
    runs: readonly MeasureRun[],
    blocks: readonly string[] | BlockBatch,
  ): Promise<Int32Array> {
    const packed = Array.isArray(blocks)
      ? packBlocks(blocks as readonly string[])
      : (blocks as BlockBatch);
    const units = packed.text.length;
    const started = this.#now();
    const answer = await this.#request({
      type: 'measure',
      id: 0,
      runs,
      text: packed.text,
      offsets: packed.offsets,
    });
    if (answer.type === 'error') throw new LayoutWorkerError(answer.code, answer.message);
    if (answer.type !== 'advances')
      throw new LayoutWorkerError('worker_failed', 'the layout worker answered out of turn');
    this.#record({
      op: 'advances',
      blocks: runs.length,
      units,
      workerMs: answer.ms,
      roundTripMs: Math.round((this.#now() - started) * 1000) / 1000,
    });
    return answer.values;
  }

  #record(stat: BatchStat): void {
    this.#stats.push(stat);
    if (this.#stats.length > STAT_LIMIT) this.#stats.shift();
  }

  /**
   * Asks the worker to hold these font files for `owner` (`''` is the platform's fonts, anything
   * else a tenant), fetching and checking the ones it does not hold. Nothing else is loaded.
   */
  async ensureFaces(owner: string, faces: readonly FaceRequest[]): Promise<FacesResult> {
    const answer = await this.#request({ type: 'faces', id: 0, owner, faces });
    if (answer.type !== 'faces')
      throw new LayoutWorkerError('worker_failed', 'the layout worker answered out of turn');
    return answer;
  }

  /** Frees the faces of `owner`, or all of them when `owner` is `null`. */
  async releaseFaces(owner: string | null): Promise<FaceStatus> {
    const answer = await this.#request({ type: 'release', id: 0, owner });
    if (answer.type !== 'status')
      throw new LayoutWorkerError('worker_failed', 'the layout worker answered out of turn');
    return answer.status;
  }

  /** What the worker holds for faces, and the size of the kernel's memory. */
  async status(): Promise<FaceStatus> {
    const answer = await this.#request({ type: 'status', id: 0 });
    if (answer.type !== 'status')
      throw new LayoutWorkerError('worker_failed', 'the layout worker answered out of turn');
    return answer.status;
  }

  /** Ends the worker and releases its memory. Waiting batches are rejected. Safe to call twice. */
  terminate(): void {
    if (this.#dead === null) this.#dead = new LayoutWorkerError('worker_stopped', 'stopped');
    this.#worker.onmessage = null;
    this.#worker.onerror = null;
    this.#worker.terminate();
    this.#rejectAll(this.#dead);
  }

  #request(message: ToWorker): Promise<FromWorker> {
    if (this.#dead !== null) return Promise.reject(this.#dead);
    const id = this.#next++;
    const stamped = { ...message, id } as ToWorker;
    return new Promise<FromWorker>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        // The typed arrays of a batch change owner here: the page keeps no copy.
        const transfer: ArrayBuffer[] = [];
        if (stamped.type === 'batch' || stamped.type === 'measure')
          transfer.push(stamped.text.buffer as ArrayBuffer, stamped.offsets.buffer as ArrayBuffer);
        this.#worker.postMessage(stamped, transfer);
      } catch (error) {
        this.#pending.delete(id);
        reject(new LayoutWorkerError('worker_failed', text(error)));
      }
    });
  }

  #receive(message: FromWorker): void {
    const waiting = this.#pending.get(message.id);
    if (!waiting) return;
    this.#pending.delete(message.id);
    if (message.type === 'error' && message.code === 'kernel_trap') {
      // A trap poisons the instance: end the worker, tell the owner once.
      waiting.reject(new LayoutWorkerError('kernel_trap', message.message));
      this.#fail(new LayoutWorkerError('kernel_trap', message.message));
      return;
    }
    waiting.resolve(message);
  }

  #fail(error: LayoutWorkerError): void {
    if (this.#dead !== null) return;
    this.#dead = error;
    this.#worker.onmessage = null;
    this.#worker.onerror = null;
    this.#worker.terminate();
    this.#rejectAll(error);
    const callback = this.#onFailure;
    this.#onFailure = null;
    callback?.(error);
  }

  #rejectAll(error: Error): void {
    const waiting = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of waiting) entry.reject(error);
  }
}

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
