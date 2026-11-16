// FE-005 criteria 3 and 4 at the session (02 §2.1): what a suspension takes away and what a resume
// brings back. The editor is a stand-in that records `suspend` and `resume`; the backend is the mock
// service's, wrapped to count `connect` and `close`; `document` is a stand-in that counts listeners.
// The same in a browser, with the real core, shell and socket: e2e/fe-005-suspend-resume.spec.ts.
import type { Backend } from '@docedit/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Session } from '../src/session.ts';
import { backendFor, fakeEditor, names, recordingHost, service, settle } from './support.ts';

const immediate = (run: () => void) => queueMicrotask(run);

/** A `document` that records the listeners in force, by event name. */
function fakeDocument() {
  const listeners = new Map<string, Set<unknown>>();
  return {
    listeners,
    visibilityState: 'visible',
    addEventListener(name: string, cb: unknown) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(cb);
    },
    removeEventListener(name: string, cb: unknown) {
      listeners.get(name)?.delete(cb);
    },
    count(): number {
      return [...listeners.values()].reduce((n, s) => n + s.size, 0);
    },
  };
}

/** The backend with `connect` and `close` counted; everything else is the backend's own. */
function counted(backend: Backend): {
  backend: Backend;
  calls: string[];
  fail: { connect: boolean };
} {
  const calls: string[] = [];
  const fail = { connect: false };
  const wrapped = new Proxy(backend, {
    get(target, key) {
      if (key === 'connect' || key === 'close')
        return async () => {
          calls.push(key);
          if (key === 'connect' && fail.connect) throw new Error('no route');
          // The mock's backend ends for good on close; a real one connects again (05 §8.2).
          if (key === 'connect' && calls.filter((c) => c === 'connect').length > 1) return;
          if (key === 'close' && calls.includes('connect')) return;
          await (target[key] as () => Promise<void>)();
        };
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  return { backend: wrapped, calls, fail };
}

/** A stand-in editor that also records suspensions, resumes and journal flushes. */
function suspendableEditor() {
  const editor = fakeEditor();
  const calls: string[] = [];
  Object.assign(editor.handle, {
    suspend: () => calls.push('suspend'),
    resume: () => calls.push('resume'),
    flushJournal: async () => {
      calls.push('flush');
    },
  });
  return { editor, calls };
}

describe('FE-005: the session suspends and resumes', () => {
  let doc: ReturnType<typeof fakeDocument>;
  const g = globalThis as { document?: unknown };
  let before: unknown;

  beforeEach(() => {
    before = g.document;
    doc = fakeDocument();
    g.document = doc;
  });
  afterEach(() => {
    if (before === undefined) delete g.document;
    else g.document = before;
  });

  async function ready(ownsBackend: boolean) {
    const { service: s, docId } = service();
    const { editor, calls } = suspendableEditor();
    const host = recordingHost(editor);
    const c = counted(backendFor(s, docId, 'editor', 'editor'));
    const session = new Session({
      docId,
      backend: ownsBackend ? async () => c.backend : c.backend,
      ownsBackend,
      host,
      scheduler: immediate,
    });
    await session.start();
    await settle();
    expect(session.phase).toBe('ready');
    return { s, session, editor, calls, host, backend: c };
  }

  it('suspend removes the listener on document, suspends the editor and keeps it (criterion 3)', async () => {
    const h = await ready(false);
    expect(doc.listeners.get('visibilitychange')?.size).toBe(1);
    h.session.suspend();
    await h.session.settled();
    expect(doc.count()).toBe(0);
    expect(h.calls).toEqual(['flush', 'suspend']);
    // The editing core is kept: nothing was destroyed and the session is still ready.
    expect(h.editor.destroyed).toBe(0);
    expect(h.session.phase).toBe('ready');
    expect(h.session.suspended).toBe(true);
    // A backend the host passed is the host's: the session leaves its socket alone.
    expect(h.backend.calls).toEqual(['connect']);
    // A second suspend does nothing.
    h.session.suspend();
    await h.session.settled();
    expect(h.calls).toEqual(['flush', 'suspend']);
    await h.session.close();
    await h.s.dispose();
  });

  it('suspend closes the socket of a backend the session created (criterion 3)', async () => {
    const h = await ready(true);
    h.session.suspend();
    await h.session.settled();
    expect(h.backend.calls).toEqual(['connect', 'close']);
    expect(h.editor.destroyed).toBe(0);
    await h.session.close();
    await h.s.dispose();
  });

  it('resume puts the listener back, connects again and resumes the editor (criterion 4)', async () => {
    const h = await ready(true);
    h.session.suspend();
    await h.session.settled();
    h.session.resume();
    await h.session.settled();
    expect(doc.listeners.get('visibilitychange')?.size).toBe(1);
    // In order: the socket closed, then opened again, and only then the editor reopened its channel.
    expect(h.backend.calls).toEqual(['connect', 'close', 'connect']);
    expect(h.calls).toEqual(['flush', 'suspend', 'resume']);
    expect(h.editor.destroyed).toBe(0);
    expect(h.editor.mounted).toHaveLength(1);
    expect(h.session.suspended).toBe(false);
    // No second `de-ready`: the same editor went on.
    expect(names(h.host.events).filter((n) => n === 'de-ready')).toHaveLength(1);
    await h.session.close();
    await h.s.dispose();
  });

  it('a resume in the same task as the suspension leaves the socket open', async () => {
    const h = await ready(true);
    h.session.suspend();
    h.session.resume();
    await h.session.settled();
    expect(h.backend.calls).not.toContain('close');
    expect(h.calls).toEqual(['flush', 'suspend', 'resume']);
    expect(doc.listeners.get('visibilitychange')?.size).toBe(1);
    await h.session.close();
    await h.s.dispose();
  });

  it('a resume without a suspension does nothing', async () => {
    const h = await ready(true);
    h.session.resume();
    await h.session.settled();
    expect(h.calls).toEqual([]);
    expect(h.backend.calls).toEqual(['connect']);
    await h.session.close();
    await h.s.dispose();
  });

  it('close after a suspension removes everything and raises nothing more', async () => {
    const h = await ready(false);
    h.session.suspend();
    await h.session.close();
    h.session.resume();
    await h.session.settled();
    expect(doc.count()).toBe(0);
    expect(h.calls).toEqual(['flush', 'suspend']);
    expect(h.editor.destroyed).toBe(1);
    await h.s.dispose();
  });

  it('a resume whose connection fails keeps the editor and reports it, not fatal', async () => {
    const h = await ready(true);
    h.session.suspend();
    await h.session.settled();
    h.backend.fail.connect = true;
    h.session.resume();
    await h.session.settled();
    expect(h.editor.destroyed).toBe(0);
    expect(h.calls).toEqual(['flush', 'suspend']);
    const errors = h.host.events.filter((e) => e.name === 'de-error').map((e) => e.detail);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ fatal: false });
    expect((errors[0] as { message: string }).message).toContain('resuming: no route');
    await h.session.close();
    await h.s.dispose();
  });
});
