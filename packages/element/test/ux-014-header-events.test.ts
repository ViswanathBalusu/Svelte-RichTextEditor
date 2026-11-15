/**
 * UX-014 criterion 5: what a host-drawn header needs besides `de-status` is raised as
 * `de-mode-change`, `de-presence` and `de-counts` (proposed, ADR 0361). The reporter is checked on
 * plain views, then on the real editing core through a session against backend-mock. The browser
 * run with `header="none"` is e2e/ux-014-host-header.spec.ts.
 */
import { describe, expect, it } from 'vitest';
import { OBSERVED_ATTRIBUTES } from '../src/doc-editor.ts';
import { EVENT_NAMES, type DocEditorEventMap, type DocEditorEventName } from '../src/events.ts';
import { HeaderEvents, headerSnapshot } from '../src/header-events.ts';
import { Session, type EditorHandle } from '../src/session.ts';
import { coreHost, until } from './core-host.ts';
import { backendFor, service } from './support.ts';

class Value<T> {
  #value: T;
  readonly #listeners = new Set<() => void>();
  constructor(value: T) {
    this.#value = value;
  }
  get(): T {
    return this.#value;
  }
  set(value: T): void {
    this.#value = value;
    for (const l of [...this.#listeners]) l();
  }
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

function views() {
  return {
    mode: new Value({ requested: 'edit', effective: 'edit' }),
    presence: new Value<
      { session: string; user: string; status?: string; name?: string; selection?: unknown }[]
    >([]),
    counts: new Value<{ comments?: number; catchUp?: number }>({}),
  };
}

describe('HeaderEvents (UX-014)', () => {
  it('raises the state at the start, then each detail only when it changes', () => {
    const v = views();
    const raised: [string, unknown][] = [];
    const stop = new HeaderEvents(v, {
      mode: (d) => raised.push(['mode', d]),
      presence: (d) => raised.push(['presence', d]),
      counts: (d) => raised.push(['counts', d]),
    }).start();
    expect(raised).toEqual([
      ['mode', { mode: 'edit', requested: 'edit' }],
      ['presence', { peers: [] }],
      ['counts', { comments: null, catchUp: null }],
    ]);

    raised.length = 0;
    // The access makes the mode in effect more restrictive than the one asked for.
    v.mode.set({ requested: 'edit', effective: 'view' });
    expect(raised).toEqual([['mode', { mode: 'view', requested: 'edit' }]]);

    raised.length = 0;
    v.mode.set({ requested: 'edit', effective: 'view' });
    v.counts.set({});
    expect(raised).toEqual([]);

    v.counts.set({ comments: 2, catchUp: 0 });
    expect(raised).toEqual([['counts', { comments: 2, catchUp: 0 }]]);

    raised.length = 0;
    stop();
    v.mode.set({ requested: 'edit', effective: 'edit' });
    expect(raised).toEqual([]);
  });

  it('carries identifiers and a status for each peer, never a name or a selection', () => {
    const v = views();
    const raised: unknown[] = [];
    new HeaderEvents(v, {
      mode: () => {},
      presence: (d) => raised.push(d),
      counts: () => {},
    }).start();
    raised.length = 0;
    v.presence.set([
      { session: 's2', user: 'bob', status: 'idle', name: 'Bob Example', selection: { anchor: 4 } },
    ]);
    expect(raised).toEqual([{ peers: [{ session: 's2', user: 'bob', status: 'idle' }] }]);
    // A peer whose selection alone moved raises nothing: the detail is the same.
    v.presence.set([{ session: 's2', user: 'bob', status: 'idle', selection: { anchor: 9 } }]);
    expect(raised).toHaveLength(1);
    expect(JSON.stringify(raised)).not.toContain('Bob Example');
  });

  it('reports a count that is not a finite, non-negative number as unknown', () => {
    const v = views();
    v.counts.set({ comments: Number.NaN, catchUp: -1 });
    expect(headerSnapshot(v).counts).toEqual({ comments: null, catchUp: null });
  });
});

describe('the embedding API of a host-drawn header (UX-014)', () => {
  it('names the three events and observes the header attribute', () => {
    for (const name of ['de-mode-change', 'de-presence', 'de-counts'])
      expect(EVENT_NAMES).toContain(name);
    expect(OBSERVED_ATTRIBUTES).toContain('header');
  });
});

describe('a session over the real core (UX-014)', () => {
  it('raises the mode in effect, presence and counts from the core, and stops at close', async () => {
    const { service: s, docId } = service();
    const backend = backendFor(s, docId, 'editor', 'editor');
    const host = coreHost();
    const raised: { name: DocEditorEventName; detail: unknown }[] = [];
    const mount = host.mount.bind(host);
    const session = new Session({
      docId,
      backend,
      ownsBackend: false,
      host: {
        emit<K extends DocEditorEventName>(name: K, detail: DocEditorEventMap[K]) {
          raised.push({ name, detail });
        },
        // The headless core's handle, with the views the element's editor hands over (src/editor.ts).
        async mount(content) {
          const handle = await mount(content);
          const core = host.cores.at(-1)!;
          const withHeader: EditorHandle = {
            ...handle,
            header: { mode: core.mode, presence: core.presence, counts: core.counts },
          };
          return withHeader;
        },
      },
    });
    await session.start();
    await until(() => raised.some((e) => e.name === 'de-ready'), 'de-ready');
    const of = (name: DocEditorEventName) =>
      raised.filter((e) => e.name === name).map((e) => e.detail);
    expect(of('de-mode-change')[0]).toEqual({ mode: 'edit', requested: 'edit' });
    expect(of('de-presence')[0]).toEqual({ peers: [] });
    expect(of('de-counts')[0]).toEqual({ comments: null, catchUp: null });

    const core = host.cores[0]!;
    core.setMode('view');
    await until(() => of('de-mode-change').length > 1, 'the mode change');
    expect(of('de-mode-change').at(-1)).toEqual({ mode: 'view', requested: 'view' });

    core.setCounts({ comments: 4, catchUp: 7 });
    await until(() => of('de-counts').length > 1, 'the counts');
    expect(of('de-counts').at(-1)).toEqual({ comments: 4, catchUp: 7 });

    await session.close();
    const before = raised.length;
    core.setCounts({ comments: 5 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(raised.length).toBe(before);
  });
});
