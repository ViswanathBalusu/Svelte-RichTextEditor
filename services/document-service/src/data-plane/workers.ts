/**
 * Worker threads for the data plane's heavy work (06 §1 stage 1, §2.2, §8; SYN-039): checkpoint
 * serialisation, replays for content reads, and the encoding of imported content. The main thread
 * only queues tasks and passes plain data; steps 2 to 7 of a commit stay on the room's loop,
 * bounded by admission control (SYN-037), because they cannot be pre-empted.
 *
 * Workers start on the first task, so that a process with no heavy work (most tests, a node that
 * only holds small rooms) spawns none. A worker that crashes, or a task that runs past its time
 * limit, fails that task; the worker is replaced. With `size` 0 the tasks run inline.
 */
import { Worker, threadId } from 'node:worker_threads';
import { runTask, type TaskName, type TaskTypes } from './tasks.ts';

interface Task {
  id: number;
  kind: TaskName;
  input: unknown;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

interface Slot {
  worker: Worker;
  task: Task | null;
  timer: ReturnType<typeof setTimeout> | null;
}

const SCRIPT = new URL('./worker.ts', import.meta.url);

/** A task failed in its worker, or the worker was lost; the message names no content. */
export class WorkerTaskError extends Error {
  override name = 'WorkerTaskError';
}

export class Workers {
  readonly #size: number;
  readonly #timeoutMs: number;
  readonly #slots: Slot[] = [];
  readonly #queue: Task[] = [];
  #next = 1;
  #closed = false;
  /** Counters for tests and metrics. */
  readonly stats = { run: 0, inline: 0, replaced: 0 };

  constructor(opts: { size: number; timeoutMs: number }) {
    this.#size = Math.max(0, Math.floor(opts.size));
    this.#timeoutMs = opts.timeoutMs;
  }

  #spawn(): Slot {
    const worker = new Worker(SCRIPT);
    const slot: Slot = { worker, task: null, timer: null };
    worker.unref();
    worker.on('message', (m: { id: number; ok: boolean; value?: unknown; error?: string }) => {
      const t = slot.task;
      if (!t || t.id !== m.id) return;
      this.#settle(slot);
      if (m.ok) t.resolve(m.value);
      else t.reject(new WorkerTaskError(`a worker task failed (${m.error ?? 'error'})`));
      this.#pump();
    });
    const lost = (why: string) => {
      const t = slot.task;
      this.#settle(slot);
      const i = this.#slots.indexOf(slot);
      if (i >= 0) {
        this.#slots.splice(i, 1);
        this.stats.replaced++;
      }
      t?.reject(new WorkerTaskError(`the worker thread stopped (${why})`));
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
    while (this.#queue.length) {
      let slot = this.#slots.find((s) => !s.task);
      if (!slot && this.#slots.length < this.#size) {
        slot = this.#spawn();
        this.#slots.push(slot);
      }
      if (!slot) return;
      const t = this.#queue.shift()!;
      slot.task = t;
      const s = slot;
      s.timer = setTimeout(() => void s.worker.terminate(), this.#timeoutMs);
      s.timer.unref?.();
      s.worker.postMessage({ id: t.id, kind: t.kind, input: t.input });
    }
  }

  /** Runs a task in a worker thread (inline with size 0). */
  run<K extends TaskName>(kind: K, input: TaskTypes[K]['input']): Promise<TaskTypes[K]['output']> {
    if (this.#closed) return Promise.reject(new WorkerTaskError('the workers are stopped'));
    this.stats.run++;
    if (this.#size === 0) {
      this.stats.inline++;
      return new Promise((resolve, reject) => {
        queueMicrotask(() => {
          try {
            resolve(runTask(kind, input, threadId));
          } catch (e) {
            reject(new WorkerTaskError(`a task failed (${e instanceof Error ? e.name : 'error'})`));
          }
        });
      });
    }
    return new Promise((resolve, reject) => {
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

  /** Threads currently started, for tests. */
  get started(): number {
    return this.#slots.length;
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const t of this.#queue.splice(0)) t.reject(new WorkerTaskError('the workers are stopped'));
    await Promise.all(
      this.#slots.splice(0).map(async (s) => {
        s.task?.reject(new WorkerTaskError('the workers are stopped'));
        this.#settle(s);
        await s.worker.terminate();
      }),
    );
  }
}
