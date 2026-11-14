/**
 * WebAssembly checks of spike S2 (ADR 0016): compiles the tiny module on the page itself, in a
 * worker created from a `blob:` URL, and in a same-origin worker whose own policy the test chooses.
 */
import { TINY_WASM, WORKER_SOURCE } from './wasm-worker-source.ts';

export interface WasmResult {
  created: boolean;
  compiled: boolean;
  instantiated: boolean;
  sum: number | null;
  error: string | null;
  violations: Array<{ directive: string; blocked: string; sample: string }>;
  timedOut?: boolean;
}

const empty = (): WasmResult => ({
  created: false,
  compiled: false,
  instantiated: false,
  sum: null,
  error: null,
  violations: [],
});

async function onPage(): Promise<WasmResult> {
  const out = { ...empty(), created: true };
  try {
    const module = await WebAssembly.compile(Uint8Array.from(TINY_WASM));
    out.compiled = true;
    const instance = await WebAssembly.instantiate(module);
    out.instantiated = true;
    out.sum = (instance.exports['add'] as (a: number, b: number) => number)(2, 3);
  } catch (e) {
    out.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }
  return out;
}

async function inWorker(
  kind: 'blob' | 'same-origin',
  workerPolicy: string | null,
): Promise<WasmResult> {
  const out = empty();
  let url: string;
  if (kind === 'blob') {
    url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
  } else {
    const run = new URLSearchParams(location.search).get('run') ?? 'none';
    url = `/wasm/worker.js?run=${encodeURIComponent(run)}${workerPolicy ? `&wcsp=${workerPolicy}` : ''}`;
  }
  let worker: Worker;
  try {
    worker = new Worker(url);
  } catch (e) {
    out.error = e instanceof Error ? `constructor: ${e.name}: ${e.message}` : String(e);
    return out;
  }
  out.created = true;
  return new Promise<WasmResult>((resolve) => {
    const timer = setTimeout(() => {
      worker.terminate();
      resolve({ ...out, timedOut: true, error: out.error ?? 'no message from the worker' });
    }, 5000);
    worker.onmessage = (e: MessageEvent<Omit<WasmResult, 'created'>>) => {
      clearTimeout(timer);
      worker.terminate();
      resolve({ ...out, ...e.data, created: true });
    };
    worker.onerror = (e) => {
      clearTimeout(timer);
      e.preventDefault();
      worker.terminate();
      resolve({ ...out, error: `worker error event: ${e.message || 'no message'}` });
    };
  });
}

Object.assign(globalThis, { __wasm: { onPage, inWorker } });
