/**
 * A layout worker for Node.js tests (WASM-004): the same `createWorkerCore` as the browser's
 * ./src/features/layout-worker.ts, on the real build of the crate, inside a `worker_threads` worker.
 * `workerData` shapes the failures a test needs: `trap` makes `checksum` trap, `compileError` makes
 * the compile refuse with that message, `status` makes the file's server answer with that status.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';
import type { KernelGlueModule } from '@docedit/layout-kernel';
import { createWorkerCore } from '../../src/features/layout-worker-core.ts';

interface Data {
  trap?: boolean;
  compileError?: string;
  status?: number;
}
const data = (workerData ?? {}) as Data;
const dist = resolve(import.meta.dirname, '../../../layout-kernel/dist');

if (data.compileError !== undefined) {
  const message = data.compileError;
  WebAssembly.compileStreaming = () => Promise.reject(new Error(message));
}

const gone = data.status !== undefined && data.status !== 200;
const fetchFile = (async () =>
  new Response(gone ? 'gone' : readFileSync(resolve(dist, 'docedit_layout_kernel_bg.wasm')), {
    status: data.status ?? 200,
    headers: { 'content-type': 'application/wasm' },
  })) as unknown as typeof fetch;

const core = createWorkerCore({
  source: {
    glue: async () => {
      const glue = (await import(
        pathToFileURL(resolve(dist, 'docedit_layout_kernel.js')).href
      )) as KernelGlueModule;
      if (!data.trap) return glue;
      return {
        ...glue,
        checksum: () => {
          throw new WebAssembly.RuntimeError('unreachable');
        },
      } as KernelGlueModule;
    },
    url: () => 'https://host.test/kernel.wasm',
  },
  fetch: fetchFile,
  post: (message, transfer) => parentPort!.postMessage(message, transfer),
});
parentPort!.on('message', (message) => void core(message));
