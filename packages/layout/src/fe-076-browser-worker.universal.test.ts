/**
 * FE-076, criterion 1 in a browser: the layout engine runs on the page's main thread and inside a
 * browser Worker, with the same serialised tree and with no `document` or `window` visible in the
 * Worker. Runs in Chromium, Firefox and WebKit (`*.universal.test.ts`). The Node.js worker_threads run
 * is `test/fe-076-worker.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { runScenario, type ScenarioRun } from './fe-076-scenario.ts';

interface WorkerLike {
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
  terminate(): void;
}
type WorkerCtor = new (url: URL, options: { type: 'module' }) => WorkerLike;

const hasWorker = typeof (globalThis as { Worker?: unknown }).Worker === 'function';

function runInBrowserWorker(): Promise<ScenarioRun> {
  const Ctor = (globalThis as unknown as { Worker: WorkerCtor }).Worker;
  return new Promise((resolve, reject) => {
    const worker = new Ctor(new URL('./fe-076-browser-worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (event) => {
      worker.terminate();
      resolve(event.data as ScenarioRun);
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message ?? 'browser worker failed'));
    };
  });
}

describe.skipIf(!hasWorker)('layout engine in a browser Worker (FE-076, criterion 1)', () => {
  it('lays out the same tree inside a browser Worker, with no document or window there', async () => {
    const onMain = runScenario();
    const inWorker = await runInBrowserWorker();
    expect(inWorker.domGlobals).toBe(false);
    expect(inWorker.pages).toBe(onMain.pages);
    expect(inWorker.serialised).toBe(onMain.serialised);
  }, 60_000);
});
