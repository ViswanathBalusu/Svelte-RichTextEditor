/**
 * The build's own layout worker (WASM-004): a module worker from the script of ./layout-worker.ts,
 * an asset next to the chunks. Its URL is resolved against this chunk, so it loads from the origin
 * that serves the component, as the PDF viewer's page does. A host needs `worker-src` for that
 * origin (integration guide). Kept apart from ./layout-worker-host.ts so that Node.js tests can load
 * the host without the bundler's worker URL.
 */
import { workerScriptURL } from '../trusted-types.ts';
import type { WorkerLike } from './layout-worker-host.ts';
import layoutWorkerUrl from './layout-worker.ts?worker&url';

export function createLayoutWorker(): WorkerLike {
  // The script's URL goes through the component's Trusted Types policy (`docedit-worker`), so a
  // host that enforces Trusted Types lists that name and nothing more.
  return new Worker(workerScriptURL(layoutWorkerUrl), {
    type: 'module',
    name: 'docedit-layout',
  }) as unknown as WorkerLike;
}
