/**
 * The layout worker's script (WASM-004; ADR 0016, decision 2). One worker for each editor
 * instance; it owns one kernel instance and answers the batches the page sends (02 §9.1).
 *
 * The bundler turns this file into a worker script of its own (a module worker, an asset next to
 * the chunks; ./layout-worker-host.ts names it with `new URL(…, import.meta.url)`). The kernel's
 * generated module and the URL of its WebAssembly file are imported here, so the worker script
 * holds the glue and fetches the file by its URL, on first use. Nothing here is on the page's
 * critical path, and no `SharedArrayBuffer` is used.
 *
 * The directive a host needs for compiling (`'wasm-unsafe-eval'`) is the one of this worker
 * script's response policy, not the page's (spike S2, section 6).
 */
import type { FromWorker, KernelGlueModule, ToWorker } from '@docedit/layout-kernel';
import * as glue from '@docedit/layout-kernel/wasm/docedit_layout_kernel.js';
import wasmUrl from '@docedit/layout-kernel/wasm/docedit_layout_kernel_bg.wasm?url&no-inline';
import { createWorkerCore } from './layout-worker-core.ts';

interface WorkerScope {
  onmessage: ((event: { data: ToWorker }) => void) | null;
  postMessage(message: FromWorker, transfer: ArrayBuffer[]): void;
}
const scope = self as unknown as WorkerScope;

const handle = createWorkerCore({
  source: {
    glue: () => Promise.resolve(glue as unknown as KernelGlueModule),
    // Resolved against this script's own URL, so it loads from the origin that serves the component.
    url: () => wasmUrl,
  },
  post: (message, transfer) => scope.postMessage(message, transfer),
});

scope.onmessage = (event) => {
  void handle(event.data);
};
