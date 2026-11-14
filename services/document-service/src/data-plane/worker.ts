/**
 * The data plane's worker thread (SYN-039): runs the tasks of tasks.ts on messages from the pool
 * (workers.ts) and answers with the result, or with the error's name only (BE-088).
 */
import { parentPort, threadId } from 'node:worker_threads';
import { runTask, type TaskName } from './tasks.ts';

parentPort?.on('message', (m: { id: number; kind: TaskName; input: never }) => {
  try {
    parentPort!.postMessage({ id: m.id, ok: true, value: runTask(m.kind, m.input, threadId) });
  } catch (e) {
    parentPort!.postMessage({ id: m.id, ok: false, error: e instanceof Error ? e.name : 'error' });
  }
});
