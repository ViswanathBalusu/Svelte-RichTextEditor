/**
 * The worker thread's entry for `fe-076-worker.test.ts` (FE-076, criterion 1): runs the layout
 * scenario and posts its result back to the main thread. Not a test file: vitest does not collect it.
 */
import { parentPort } from 'node:worker_threads';
import { runScenario } from '../src/fe-076-scenario.ts';

parentPort?.postMessage(runScenario());
