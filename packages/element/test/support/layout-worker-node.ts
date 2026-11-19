/**
 * A layout worker for Node.js tests (WASM-004, WASM-005): the same `createWorkerCore` as the
 * browser's ./src/features/layout-worker.ts, on the real build of the crate, inside a
 * `worker_threads` worker. Its `fetch` serves the kernel's file at `https://host.test/kernel.wasm`
 * and a font file at `https://host.test/fonts/<name>` from packages/perf/fonts/files.
 *
 * `workerData` shapes what a test needs: `trap` makes `checksum` trap, `compileError` makes the
 * compile refuse with that message, `status` makes the kernel file's server answer with that status,
 * `corrupt` lists font names whose bytes are served with one byte changed. A message
 * `{ type: '__fetched' }` is answered with the URLs the worker has fetched, so that a test can see
 * what was and was not loaded.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';
import type { KernelGlueModule, ToWorker } from '@docedit/layout-kernel';
import { createWorkerCore } from '../../src/features/layout-worker-core.ts';

interface Data {
  trap?: boolean;
  compileError?: string;
  status?: number;
  corrupt?: string[];
}
const data = (workerData ?? {}) as Data;
const dist = resolve(import.meta.dirname, '../../../layout-kernel/dist');
const fonts = resolve(import.meta.dirname, '../../../perf/fonts/files');

if (data.compileError !== undefined) {
  const message = data.compileError;
  WebAssembly.compileStreaming = () => Promise.reject(new Error(message));
}

const fetched: string[] = [];
const fetchFile = (async (input: string) => {
  fetched.push(input);
  const font = /^https:\/\/host\.test\/fonts\/(.+)$/.exec(input);
  if (font) {
    const name = decodeURIComponent(font[1]!);
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = new Uint8Array(readFileSync(resolve(fonts, name)));
    } catch {
      return new Response('gone', { status: 404 });
    }
    if (data.corrupt?.includes(name)) bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    return new Response(bytes, { headers: { 'content-type': 'font/ttf' } });
  }
  const gone = data.status !== undefined && data.status !== 200;
  return new Response(
    gone ? 'gone' : readFileSync(resolve(dist, 'docedit_layout_kernel_bg.wasm')),
    {
      status: data.status ?? 200,
      headers: { 'content-type': 'application/wasm' },
    },
  );
}) as unknown as typeof fetch;

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
parentPort!.on('message', (message: ToWorker | { type: '__fetched' }) => {
  if (message.type === '__fetched') parentPort!.postMessage({ type: '__fetched', urls: fetched });
  else void core(message);
});
