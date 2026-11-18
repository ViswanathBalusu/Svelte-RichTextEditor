/**
 * The assistant port as the shell's pane reads it (UX-045; 13 §6.2).
 *
 * The backend's `AssistantPort` is attached with the session and taken away with it. While it is
 * attached `available` is true and the shell offers the assistant pane and its command. A request is
 * built by the core from what the reader may view (UX-047), sent to the port, and streamed back. The
 * bridge writes nothing to the document: an answer is data, and reaches the text only through the
 * author's approval as suggestions (UX-046).
 */
import type { AssistantPort, CancelSignal } from '@docedit/protocol';
import type { AssistantApi, AssistantStreamChunk, AssistantTaskName } from '@docedit/ui';
import type { ReadView } from './session.ts';

/** The request the core builds: `task` and `prompt` as given, with the document and its context. */
type BuildRequest = (
  task: AssistantTaskName,
  prompt: string,
) => Parameters<AssistantPort['request']>[0];

export interface AssistantBridge {
  readonly api: AssistantApi;
  /** Attaches the port, or takes it away with `undefined`. */
  attach(port: AssistantPort | undefined): void;
}

function cancelSignal(signal: AbortSignal): CancelSignal {
  return {
    get cancelled() {
      return signal.aborted;
    },
    onCancel(cb) {
      if (signal.aborted) {
        cb();
        return () => {};
      }
      signal.addEventListener('abort', cb, { once: true });
      return () => signal.removeEventListener('abort', cb);
    },
  };
}

export function assistantBridge(build: BuildRequest): AssistantBridge {
  let port: AssistantPort | undefined;
  let available = false;
  const listeners = new Set<() => void>();
  const view: ReadView<boolean> = {
    get: () => available,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    api: {
      available: view,
      async *request(task, prompt, signal): AsyncIterable<AssistantStreamChunk> {
        const current = port;
        if (!current) throw new Error('no assistant port is attached');
        const stream = current.request(build(task, prompt), { signal: cancelSignal(signal) });
        for await (const chunk of stream) {
          if (chunk.kind === 'text') yield { kind: 'text', text: chunk.text };
          else if (chunk.kind === 'done') yield { kind: 'done' };
          else yield { kind: 'error', code: chunk.code, message: chunk.message };
        }
      },
    },
    attach(next) {
      port = next;
      const now = next !== undefined;
      if (now === available) return;
      available = now;
      for (const listener of [...listeners]) listener();
    },
  };
}
