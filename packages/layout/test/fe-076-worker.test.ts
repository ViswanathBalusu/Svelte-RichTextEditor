/**
 * FE-076, criterion 1 in part: the layout engine runs in Node.js on the main thread and in a Node.js
 * worker thread, with the same result, and with no browser global visible in either. This is a
 * worker_threads run, not a browser Worker: no browser run is made here (see the story's Notes).
 */
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { runScenario, type ScenarioRun } from '../src/fe-076-scenario.ts';

function runInWorker(): Promise<ScenarioRun> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./fe-076-worker-entry.ts', import.meta.url));
    let settled = false;
    worker.once('message', (message: ScenarioRun) => {
      settled = true;
      resolve(message);
    });
    worker.once('error', (error) => {
      settled = true;
      reject(error);
    });
    worker.once('exit', (code) => {
      if (!settled) reject(new Error(`worker exited with code ${code} before it reported`));
    });
  });
}

describe('layout engine in Node.js and in a worker thread (FE-076, criterion 1)', () => {
  it('lays out the scenario on the main thread with no browser global visible', () => {
    const run = runScenario();
    expect(run.domGlobals).toBe(false);
    expect(run.pages).toBeGreaterThan(0);
  });

  it('lays out the same tree in a worker thread, with no browser global visible there', async () => {
    const onMain = runScenario();
    const inWorker = await runInWorker();
    expect(inWorker.domGlobals).toBe(false);
    expect(inWorker.pages).toBe(onMain.pages);
    expect(inWorker.serialised).toBe(onMain.serialised);
  }, 60_000);
});
