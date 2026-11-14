/**
 * The browser Worker entry for `fe-076-browser-worker.universal.test.ts` (FE-076, criterion 1): runs the
 * layout scenario inside a browser Worker and posts its result back. Not a test file: vitest does not
 * collect it. The Worker global is not typed here (the universal package has no DOM types), so the
 * posting function is reached through a structural type.
 */
import { runScenario } from './fe-076-scenario.ts';

const scope = globalThis as unknown as { postMessage(message: unknown): void };
scope.postMessage(runScenario());
