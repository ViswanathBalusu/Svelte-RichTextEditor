/**
 * UX-045 at the level of the controller (Node.js): the request lifecycle with a fake assistant API.
 * The rendered pane, the live region and keyboard use are in packages/ui/e2e/ux-045-assistant-pane.spec.ts.
 */
import { describe, expect, it } from 'vitest';
import type { AssistantApi, AssistantStreamChunk, Capability } from '../src/core-api.ts';
import { createAssistantController, failureOf } from '../src/assistant/controller.ts';
import { BUILT_IN_PANES, PaneRegistry } from '../src/shell/panes.ts';
import { EN_GB } from '../src/i18n/en-GB.ts';

const view = <T>(value: T) => ({ get: () => value, subscribe: () => () => {} });

/** An API that answers from a script, and records the tasks and the signals it was given. */
function fakeApi(script: (signal: AbortSignal) => AsyncIterable<AssistantStreamChunk>) {
  const calls: Array<{ task: string; prompt: string; signal: AbortSignal }> = [];
  const api: AssistantApi = {
    available: view(true),
    request(task, prompt, signal) {
      calls.push({ task, prompt, signal });
      return script(signal);
    },
  };
  return { api, calls };
}

async function* chunks(...items: AssistantStreamChunk[]): AsyncIterable<AssistantStreamChunk> {
  for (const item of items) yield item;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const EDITOR: Capability[] = ['view', 'comment', 'suggest', 'edit'];
const VIEWER: Capability[] = ['view'];

function make(api: AssistantApi, caps: Capability[] = EDITOR) {
  return createAssistantController({ api, caps: () => caps, onChange: () => {} });
}

describe('assistant controller (UX-045)', () => {
  it('shows the response of each kind and maps the kinds to the port tasks (criterion 1)', async () => {
    const { api, calls } = fakeApi(() =>
      chunks({ kind: 'text', text: 'Hel' }, { kind: 'text', text: 'lo' }, { kind: 'done' }),
    );
    const c = make(api);
    const tasks: string[] = [];
    for (const kind of ['draft', 'rewrite', 'summary', 'question'] as const) {
      expect(c.ask(kind, `p-${kind}`)).toBe(true);
      await tick();
      expect(c.view().state).toMatchObject({ phase: 'shown', kind, text: 'Hello' });
      tasks.push(calls.at(-1)!.task);
      c.dismiss();
    }
    expect(tasks).toEqual(['draft', 'rewrite', 'summarise', 'answer']);
    expect(calls.map((x) => x.prompt)).toEqual(['p-draft', 'p-rewrite', 'p-summary', 'p-question']);
  });

  it('holds the response and inserts it only on approval, through the API (criterion 2; UX-046)', async () => {
    const inserted: string[] = [];
    const { api } = fakeApi(() => chunks({ kind: 'text', text: 'New text' }, { kind: 'done' }));
    api.insert = (text) => (inserted.push(text), { ok: true });
    const c = make(api);
    c.ask('draft', 'x');
    await tick();
    expect(c.view().state.phase).toBe('shown');
    expect(inserted).toEqual([]);
    expect(await c.approve()).toBe(true);
    expect(inserted).toEqual(['New text']);
    expect(c.view()).toMatchObject({ state: { phase: 'idle' }, inserted: true });
  });

  it('keeps the result shown and says why when the core refuses the insertion (UX-046 criterion 4)', async () => {
    const { api } = fakeApi(() => chunks({ kind: 'text', text: 'T' }, { kind: 'done' }));
    api.insert = () => ({ ok: false, reason: 'no-suggest' });
    const c = make(api);
    c.ask('draft', 'x');
    await tick();
    expect(await c.approve()).toBe(false);
    expect(c.view()).toMatchObject({
      state: { phase: 'shown', text: 'T' },
      insertRefused: 'no-suggest',
      inserted: false,
    });
  });

  it('inserts nothing for a view-only author or without an insertion in the API', async () => {
    const { api } = fakeApi(() => chunks({ kind: 'text', text: 'T' }, { kind: 'done' }));
    const calls: string[] = [];
    const withInsert = {
      ...api,
      insert: (text: string) => (calls.push(text), { ok: true } as const),
    };
    const viewer = make(withInsert, VIEWER);
    viewer.ask('question', 'q');
    await tick();
    expect(await viewer.approve()).toBe(false);
    const bare = make(api);
    bare.ask('question', 'q');
    await tick();
    expect(await bare.approve()).toBe(false);
    expect(calls).toEqual([]);
  });

  it('cancels a running request: it is aborted at the port and a late answer is ignored (criterion 3)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { api, calls } = fakeApi(async function* () {
      yield { kind: 'text', text: 'partial' } as const;
      await gate;
      yield { kind: 'text', text: ' late' } as const;
      yield { kind: 'done' } as const;
    });
    const c = make(api);
    c.ask('draft', 'x');
    await tick();
    expect(c.view().state.phase).toBe('running');
    c.cancel();
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(c.view().state.phase).toBe('cancelled');
    release();
    await tick();
    expect(c.view().state.phase).toBe('cancelled');
    expect(await c.approve()).toBe(false);
  });

  it('ends a failure with nothing held and retry offered, for each failure kind (criterion 4)', async () => {
    for (const [code, failure] of [
      ['rate_limited', 'rate_limited'],
      ['quota_exceeded', 'quota_exceeded'],
      ['internal', 'port_failure'],
    ] as const) {
      const { api } = fakeApi(() =>
        chunks({ kind: 'text', text: 'x' }, { kind: 'error', code, message: 'm' }),
      );
      const c = make(api);
      c.ask('question', 'q');
      await tick();
      expect(c.view().state).toMatchObject({ phase: 'failed', failure, retry: true });
      expect(await c.approve()).toBe(false);
      expect(EN_GB[`assistant.error.${failure}`]).toMatch(/Nothing was applied/);
    }
  });

  it('treats a thrown error as a port failure and retries the same request', async () => {
    let n = 0;
    const { api, calls } = fakeApi(async function* () {
      n++;
      if (n === 1) throw new Error('down');
      yield { kind: 'text', text: 'ok' } as const;
      yield { kind: 'done' } as const;
    });
    const c = make(api);
    c.ask('summary', 'sum');
    await tick();
    expect(c.view().state).toMatchObject({ phase: 'failed', failure: 'port_failure' });
    expect(c.retry()).toBe(true);
    await tick();
    expect(c.view().state).toMatchObject({ phase: 'shown', text: 'ok' });
    expect(calls.map((x) => [x.task, x.prompt])).toEqual([
      ['summarise', 'sum'],
      ['summarise', 'sum'],
    ]);
    expect(c.retry()).toBe(false);
  });

  it('lets a view-only author ask and summarise, and refuses draft and rewrite with a reason (criterion 6)', async () => {
    const { api, calls } = fakeApi(() => chunks({ kind: 'text', text: 'a' }, { kind: 'done' }));
    const c = make(api, VIEWER);
    expect(c.ask('draft', 'x')).toBe(false);
    expect(c.view().refused).toBe('no-change');
    expect(c.ask('rewrite', 'x')).toBe(false);
    expect(calls).toHaveLength(0);
    expect(c.ask('question', 'q')).toBe(true);
    await tick();
    expect(c.view().refused).toBeNull();
    expect(c.view().state.phase).toBe('shown');
    // A view-only author's approval inserts nothing.
    expect(await c.approve()).toBe(false);
    expect(EN_GB['assistant.refused.no-change']).toMatch(/does not allow/);
  });

  it('does not start a second request while one runs, and aborts on dispose', () => {
    const { api, calls } = fakeApi(async function* () {
      await new Promise(() => {});
      yield { kind: 'done' } as const;
    });
    const c = make(api);
    expect(c.ask('draft', 'a')).toBe(true);
    expect(c.ask('draft', 'b')).toBe(false);
    expect(calls).toHaveLength(1);
    c.dispose();
    expect(calls[0]!.signal.aborted).toBe(true);
  });

  it('names failures by code', () => {
    expect(failureOf('rate_limited')).toBe('rate_limited');
    expect(failureOf('quota_exceeded')).toBe('quota_exceeded');
    expect(failureOf('whatever')).toBe('port_failure');
  });
});

describe('the assistant pane is offered only with an attached port (criterion 5)', () => {
  const core = (assistant?: AssistantApi) => ({ assistant }) as never;
  it('has a loader, and is offered only while the port is available', () => {
    const registry = new PaneRegistry(BUILT_IN_PANES);
    expect(registry.get('assistant')?.load).toBeTypeOf('function');
    expect(registry.offered('assistant', core(), [], [])).toBe(false);
    const off: AssistantApi = { available: view(false), request: () => chunks() };
    const on: AssistantApi = { available: view(true), request: () => chunks() };
    expect(registry.offered('assistant', core(off), [], [])).toBe(false);
    expect(registry.offered('assistant', core(on), [], [])).toBe(true);
  });
});
