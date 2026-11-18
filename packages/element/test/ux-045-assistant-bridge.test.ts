/**
 * UX-045: the element's bridge from the backend's assistant port to the shell's `AssistantApi`
 * (Node.js; the pane itself is in packages/ui/e2e/ux-045-assistant-pane.spec.ts). The bridge is
 * unavailable until a port is attached, builds each request through the core, maps the chunks, and
 * hands the port a cancel signal that follows the shell's abort.
 */
import type { AssistantChunk, AssistantPort, CancelSignal } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { assistantBridge } from '../src/assistant.ts';

type Request = Parameters<AssistantPort['request']>[0];

const REQUEST = (task: string, prompt: string): Request =>
  ({ docId: 'd1', task, prompt, context: { blocks: [] } }) as unknown as Request;

function port(chunks: AssistantChunk[]) {
  const seen: Array<{ request: Request; signal: CancelSignal | undefined }> = [];
  const p: AssistantPort = {
    async *request(request, opts) {
      seen.push({ request, signal: opts?.signal });
      for (const chunk of chunks) yield chunk;
    },
  };
  return { p, seen };
}

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

describe('assistant bridge (UX-045)', () => {
  it('is unavailable until a port is attached, tells subscribers, and refuses requests without one', async () => {
    const bridge = assistantBridge((task, prompt) => REQUEST(task, prompt));
    let told = 0;
    bridge.api.available.subscribe(() => told++);
    expect(bridge.api.available.get()).toBe(false);
    await expect(
      collect(bridge.api.request('draft', 'x', new AbortController().signal)),
    ).rejects.toThrow();
    bridge.attach(port([]).p);
    expect(bridge.api.available.get()).toBe(true);
    bridge.attach(port([]).p);
    expect(told).toBe(1);
    bridge.attach(undefined);
    expect(bridge.api.available.get()).toBe(false);
    expect(told).toBe(2);
  });

  it('builds the request through the core, maps the chunks and passes a cancel signal', async () => {
    const { p, seen } = port([
      { kind: 'text', text: 'a' },
      { kind: 'done', agent: 'agt1' },
      { kind: 'error', code: 'rate_limited', message: 'slow down' },
    ]);
    const bridge = assistantBridge((task, prompt) => REQUEST(task, prompt));
    bridge.attach(p);
    const abort = new AbortController();
    const out = await collect(bridge.api.request('summarise', 'sum', abort.signal));
    expect(out).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'done' },
      { kind: 'error', code: 'rate_limited', message: 'slow down' },
    ]);
    expect(seen[0]!.request).toMatchObject({ docId: 'd1', task: 'summarise', prompt: 'sum' });
    const signal = seen[0]!.signal!;
    expect(signal.cancelled).toBe(false);
    let called = 0;
    signal.onCancel(() => called++);
    abort.abort();
    expect(signal.cancelled).toBe(true);
    expect(called).toBe(1);
    let late = 0;
    signal.onCancel(() => late++);
    expect(late).toBe(1);
  });
});
