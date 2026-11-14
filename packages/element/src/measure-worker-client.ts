// Starts the element's measuring worker (FE-063; `measure-worker.ts`) and talks to it. The first
// message is always `start` with the manifest's files, so the worker has registered the page's
// aliases before it is asked for any width. Whether layout runs in a worker is still open (02 §15;
// FE-075); this is the worker that a layout pass off the main thread measures with.
import type { CanvasFontKey } from './canvas-measure.ts';
import type { FontFileEntry } from './font-registration.ts';
import type { MeasureReply, MeasureRequest } from './worker-fonts.ts';

/** The part of a Worker the client uses. */
export interface WorkerLike {
  postMessage(message: MeasureRequest): void;
  addEventListener(
    type: 'message',
    listener: (event: { readonly data: MeasureReply }) => void,
  ): void;
  addEventListener(type: 'error', listener: (event: { readonly message?: string }) => void): void;
  terminate(): void;
}

/** A failed request: `code` is the worker's (`not_started`, `face_missing`, `load_failed`, ...). */
export class MeasureWorkerError extends Error {
  override name = 'MeasureWorkerError';
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface MeasureWorkerClient {
  /** The aliases the worker registered, in manifest order. */
  readonly ready: Promise<readonly string[]>;
  /** The advance of `text` in `font`, in points, measured in the worker once its face is loaded. */
  advance(font: CanvasFontKey, text: string): Promise<number>;
  terminate(): void;
}

/** The element's measuring worker, as a module worker (Vite bundles the entry with the element). */
export function spawnMeasureWorker(): WorkerLike {
  return new Worker(new URL('./measure-worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as WorkerLike;
}

/** Starts the worker with the manifest's files and returns a client for its widths. */
export function startMeasureWorker(
  entries: readonly FontFileEntry[],
  spawn: () => WorkerLike = spawnMeasureWorker,
): MeasureWorkerClient {
  const worker = spawn();
  let next = 0;
  const waiting = new Map<number, { resolve(r: MeasureReply): void; reject(e: Error): void }>();
  worker.addEventListener('message', (event) => {
    const pending = waiting.get(event.data.id);
    if (!pending) return;
    waiting.delete(event.data.id);
    pending.resolve(event.data);
  });
  worker.addEventListener('error', (event) => {
    const error = new MeasureWorkerError(
      'worker_error',
      event.message ?? 'the measuring worker failed',
    );
    for (const pending of waiting.values()) pending.reject(error);
    waiting.clear();
  });
  const ask = (request: MeasureRequest): Promise<MeasureReply> =>
    new Promise((resolve, reject) => {
      waiting.set(request.id, { resolve, reject });
      worker.postMessage(request);
    });
  const failed = (reply: MeasureReply): MeasureWorkerError =>
    reply.kind === 'error'
      ? new MeasureWorkerError(reply.code, reply.message)
      : new MeasureWorkerError('unexpected', `unexpected reply ${reply.kind}`);

  const ready = ask({ kind: 'start', id: next++, entries }).then((reply) => {
    if (reply.kind !== 'started') throw failed(reply);
    return reply.aliases;
  });
  // A caller that never awaits `ready` still learns of a failure from `advance`.
  ready.catch(() => {});
  return {
    ready,
    async advance(font, text) {
      const reply = await ask({ kind: 'measure', id: next++, font, text });
      if (reply.kind !== 'width') throw failed(reply);
      return reply.width;
    },
    terminate() {
      worker.terminate();
      const error = new MeasureWorkerError('terminated', 'the measuring worker was stopped');
      for (const pending of waiting.values()) pending.reject(error);
      waiting.clear();
    },
  };
}
