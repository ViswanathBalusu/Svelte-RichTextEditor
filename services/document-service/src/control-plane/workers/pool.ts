/**
 * Worker threads for work that would block the event loop (06 §1 stage 1; BE-001 criteria 3, 4):
 * log replay for content reads, comparisons, and the serialisation of the content a document is
 * created with (replay-worker.ts). The rooms' checkpoints and the conversion of replaced or imported
 * content run in the data plane's own pool (data-plane/workers.ts).
 * The main thread only queues tasks and passes messages, so it keeps serving requests and rooms
 * while a replay runs. A worker that crashes, or a task that runs past its time limit, fails the
 * task with the retryable code `internal`; the worker is replaced and the process goes on.
 */
import { Worker } from 'node:worker_threads';
import { ApiError } from '../problems.ts';

export interface WorkerPoolOptions {
  /** Number of worker threads. */
  size: number;
  /** Longest a task may run, ms; the worker is then terminated (06 §8 "time limits"). */
  taskTimeoutMs: number;
  /** Lets the `crash` task end its worker: for the tests of BE-001 criterion 4 only. */
  allowCrash?: boolean;
}

interface Task {
  id: number;
  kind: string;
  input: unknown;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

interface Slot {
  worker: Worker;
  task: Task | null;
  timer: NodeJS.Timeout | null;
}

const SCRIPT = new URL('./replay-worker.ts', import.meta.url);

export class WorkerPool {
  readonly #o: WorkerPoolOptions;
  readonly #slots: Slot[] = [];
  readonly #queue: Task[] = [];
  #next = 1;
  #closed = false;
  /** Workers replaced after a crash or a timeout, for the tests and the metrics. */
  replaced = 0;

  constructor(opts: WorkerPoolOptions) {
    if (!Number.isSafeInteger(opts.size) || opts.size < 1)
      throw new RangeError('a pool has at least one worker');
    this.#o = opts;
    for (let i = 0; i < opts.size; i++) this.#slots.push(this.#spawn());
  }

  #spawn(): Slot {
    const worker = new Worker(SCRIPT, { workerData: { allowCrash: this.#o.allowCrash === true } });
    const slot: Slot = { worker, task: null, timer: null };
    worker.unref();
    worker.on('message', (m: { id: number; ok: boolean; value?: unknown; error?: string }) => {
      const t = slot.task;
      if (!t || t.id !== m.id) return;
      this.#settle(slot);
      if (m.ok) t.resolve(m.value);
      else t.reject(new ApiError('internal', `a worker task failed (${m.error ?? 'error'})`));
      this.#pump();
    });
    const lost = (why: string) => {
      const t = slot.task;
      this.#settle(slot);
      const i = this.#slots.indexOf(slot);
      if (i >= 0 && !this.#closed) {
        this.#slots[i] = this.#spawn();
        this.replaced++;
      }
      t?.reject(new ApiError('internal', `the worker thread stopped (${why}); retry the request`));
      this.#pump();
    };
    worker.on('error', (e) => lost(e instanceof Error ? e.name : 'error'));
    worker.on('exit', (code) => {
      if (!this.#closed) lost(`exit ${code}`);
    });
    return slot;
  }

  #settle(slot: Slot): void {
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    slot.task = null;
  }

  #pump(): void {
    if (this.#closed) return;
    for (const slot of this.#slots) {
      if (slot.task) continue;
      const t = this.#queue.shift();
      if (!t) return;
      slot.task = t;
      slot.timer = setTimeout(() => {
        // Terminating fires 'exit', which fails the task and replaces the worker.
        void slot.worker.terminate();
      }, this.#o.taskTimeoutMs);
      slot.worker.postMessage({ id: t.id, kind: t.kind, input: t.input });
    }
  }

  /** Runs a task in a worker thread. Rejects with ApiError `internal` when the worker is lost. */
  run<T>(kind: string, input: unknown): Promise<T> {
    if (this.#closed) return Promise.reject(new ApiError('unavailable', 'the service is stopping'));
    return new Promise<T>((resolve, reject) => {
      this.#queue.push({
        id: this.#next++,
        kind,
        input,
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.#pump();
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const t of this.#queue.splice(0))
      t.reject(new ApiError('unavailable', 'the service is stopping'));
    await Promise.all(
      this.#slots.map(async (s) => {
        s.task?.reject(new ApiError('unavailable', 'the service is stopping'));
        this.#settle(s);
        await s.worker.terminate();
      }),
    );
  }
}
