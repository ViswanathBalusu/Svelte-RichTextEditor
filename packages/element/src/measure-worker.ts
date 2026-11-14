// The element's measuring worker entry (FE-063; 02 §3, §6, §9.3). It answers the requests of
// `measure-worker-client.ts` with `measureHandler` (worker-fonts.ts): `start` registers the
// manifest's files on the worker's own font set under the page's aliases, and each `measure` waits
// for its face before it measures. Load it only as a module worker; on a page it would take over
// the page's `onmessage`.
import { measureHandler, type MeasureReply, type MeasureRequest } from './worker-fonts.ts';

interface WorkerScope {
  postMessage(reply: MeasureReply): void;
  onmessage: ((event: { readonly data: MeasureRequest }) => void) | null;
}

const scope = globalThis as unknown as WorkerScope;
const handle = measureHandler(scope);

scope.onmessage = (event) => {
  void handle(event.data).then(
    (reply) => scope.postMessage(reply),
    (error: unknown) =>
      scope.postMessage({
        kind: 'error',
        id: event.data.id,
        code: 'internal',
        message: error instanceof Error ? error.message.slice(0, 200) : 'failed',
      }),
  );
};
