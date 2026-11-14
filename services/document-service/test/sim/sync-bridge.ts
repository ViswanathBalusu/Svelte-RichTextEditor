/**
 * Synchronous calls into the bridge worker (SYN-047). The S3 simulation is synchronous by design
 * (every room method returns its effects, and the harness performs the write and reports its
 * outcome in the same step), so its storage must answer synchronously. This posts a request to
 * the worker that holds the PostgreSQL stores and blocks the calling thread on a shared flag
 * until the reply is on the reply port.
 */
import type pg from 'pg';
import {
  MessageChannel,
  receiveMessageOnPort,
  Worker,
  type MessagePort,
} from 'node:worker_threads';

type Reply = { ok: true; value: unknown } | { ok: false; error: string };

export class SyncBridge {
  readonly #worker: Worker;
  readonly #reply: MessagePort;
  readonly #flag: Int32Array;
  readonly #timeoutMs: number;
  calls = 0;

  constructor(pool: pg.PoolConfig, tenant: string, timeoutMs = 60_000) {
    const signal = new SharedArrayBuffer(4);
    this.#flag = new Int32Array(signal);
    const { port1, port2 } = new MessageChannel();
    this.#reply = port1;
    this.#timeoutMs = timeoutMs;
    this.#worker = new Worker(new URL('./bridge-worker.ts', import.meta.url), {
      workerData: { pool, tenant, signal, reply: port2 },
      transferList: [port2],
      execArgv: [],
    });
  }

  call<T>(method: string, args?: unknown): T {
    this.calls++;
    Atomics.store(this.#flag, 0, 0);
    this.#worker.postMessage({ method, args });
    const deadline = Date.now() + this.#timeoutMs;
    for (;;) {
      const waited = Atomics.wait(this.#flag, 0, 0, Math.max(1, deadline - Date.now()));
      const msg = receiveMessageOnPort(this.#reply);
      if (msg) {
        const reply = msg.message as Reply;
        if (!reply.ok) throw new Error(`bridge ${method}: ${reply.error}`);
        return reply.value as T;
      }
      if (waited === 'timed-out' || Date.now() > deadline)
        throw new Error(`bridge ${method}: no reply within ${this.#timeoutMs} ms`);
    }
  }

  async close(): Promise<void> {
    try {
      this.call('close');
    } finally {
      await this.#worker.terminate();
    }
  }
}
