// The page glue of the reference host (UX-093) against a fake element and a fake fetch: the token
// source's refusals, the handling of `de-auth-required`, `de-error` and `de-share-request`, the
// flush before navigation, and the guide comments of the module. The element is a stand-in with
// the members of `EditorLike`; the element itself is tested in packages/element.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_RETRY_WINDOW_MS,
  attachEditor,
  directoryResolver,
  flushBeforeNavigation,
  principalSearch,
  tokenSource,
  type EditorLike,
} from '../src/lib/glue/page-glue.ts';

afterEach(() => {
  vi.useRealTimers();
});

/** A stand-in for `<doc-editor>`: an event target with the members the glue sets and calls. */
class FakeEditor extends EventTarget {
  readonly attributes = new Map<string, string>();
  getToken: EditorLike['getToken'] = null;
  resolveUsers: EditorLike['resolveUsers'] = null;
  searchPrincipals: EditorLike['searchPrincipals'] = null;
  flush?: (options: { timeoutMs: number }) => Promise<void>;
  loads = 0;

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  load(): void {
    this.loads += 1;
  }
  fire(type: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
  asEditor(): EditorLike {
    return this as unknown as EditorLike;
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A fetch that records each call and answers with `respond`. */
function fakeFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return respond(url, init ?? {});
  }) as typeof fetch;
  return { f, calls };
}

const API = '/as/u-ada/api';

describe('getToken: the token source and its refusals (UX-092 criteria 3 and 5, UX-093)', () => {
  it('posts the document identifier and returns the token from the body, never in a URL', async () => {
    const seen: string[] = [];
    const { f, calls } = fakeFetch((url) => {
      seen.push(url);
      return json(200, { token: 'header.payload.signature', expiresAt: '2030-01-01T00:00:00Z' });
    });
    const refusals: Array<string | null> = [];
    const get = tokenSource(API, (r) => refusals.push(r), f);
    await expect(get({ docId: 'doc-1' })).resolves.toBe('header.payload.signature');
    expect(calls).toHaveLength(1);
    expect(seen[0]).toBe(`${API}/token`);
    expect(seen[0]).not.toContain('signature');
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init as { cache?: string }).cache).toBe('no-store');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ docId: 'doc-1' });
    expect(refusals).toEqual([null]);
  });

  it('reports a 401 as a lost session, a 403 or 404 as no access, and anything else as unavailable', async () => {
    const cases: Array<[number, string]> = [
      [401, 'session'],
      [403, 'access'],
      [404, 'access'],
      [500, 'unavailable'],
    ];
    for (const [status, reason] of cases) {
      const { f } = fakeFetch(() => json(status, {}));
      const refusals: Array<string | null> = [];
      const get = tokenSource(API, (r) => refusals.push(r), f);
      await expect(get({ docId: 'doc-1' })).rejects.toThrow();
      expect(refusals).toEqual([reason]);
    }
  });

  it('reports a host that cannot be reached as unavailable', async () => {
    const f = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const refusals: Array<string | null> = [];
    const get = tokenSource(API, (r) => refusals.push(r), f);
    await expect(get({ docId: 'doc-1' })).rejects.toThrow(/could not be reached/);
    expect(refusals).toEqual(['unavailable']);
  });
});

describe('the directory calls of the glue (UX-093; the seeded answers come from the route)', () => {
  it('sends identifiers for resolution and returns the users in order', async () => {
    const { f, calls } = fakeFetch(() =>
      json(200, { users: [{ id: 'u-bob', name: 'Bob Mensah' }, null] }),
    );
    const resolve = directoryResolver(API, f);
    await expect(resolve(['u-bob', 'nobody'])).resolves.toEqual([
      { id: 'u-bob', name: 'Bob Mensah' },
      null,
    ]);
    expect(calls[0]!.url).toBe(`${API}/directory`);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ resolve: ['u-bob', 'nobody'] });
  });

  it('searches with the default kinds and a limit of 10 unless the element asks otherwise', async () => {
    const { f, calls } = fakeFetch(() =>
      json(200, { principals: [{ principal: 'user:u-bob', name: 'Bob Mensah' }] }),
    );
    const search = principalSearch(API, f);
    await expect(search({ text: 'bo', docId: 'doc-1', purpose: 'grant' })).resolves.toEqual([
      { principal: 'user:u-bob', name: 'Bob Mensah' },
    ]);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      search: { text: 'bo', kinds: ['user', 'group'], limit: 10 },
    });
    expect(calls).toHaveLength(1);
  });

  it('throws when the host answers with an error', async () => {
    const { f } = fakeFetch(() => json(500, {}));
    await expect(directoryResolver(API, f)(['u-bob'])).rejects.toThrow(/500/);
    await expect(
      principalSearch(API, f)({ text: 'x', docId: 'doc-1', purpose: 'grant' }),
    ).rejects.toThrow(/500/);
  });
});

describe('attachEditor: de-auth-required, de-error, de-status and de-share-request (UX-093 criterion 2 and 6)', () => {
  function setup(respond: Parameters<typeof fakeFetch>[0]) {
    const el = new FakeEditor();
    const { f } = fakeFetch(respond);
    const callbacks = {
      onSignInNeeded: vi.fn(),
      onAccessLost: vi.fn(),
      onError: vi.fn(),
      onStatus: vi.fn(),
      onShareRequest: vi.fn(),
    };
    const detach = attachEditor(el.asEditor(), {
      api: API,
      docId: 'doc-1',
      fetch: f,
      ...callbacks,
    });
    return { el, callbacks, detach };
  }

  it('sets the document identifier and the three directory and token members', () => {
    const { el, detach } = setup(() => json(200, {}));
    expect(el.getAttribute('doc-id')).toBe('doc-1');
    expect(el.getToken).toEqual(expect.any(Function));
    expect(el.resolveUsers).toEqual(expect.any(Function));
    expect(el.searchPrincipals).toEqual(expect.any(Function));
    detach();
  });

  it('shows the host sign-in when the host session ended', async () => {
    const { el, callbacks } = setup(() => json(401, {}));
    await expect(el.getToken!({ docId: 'doc-1' })).rejects.toThrow();
    el.fire('de-auth-required', {});
    expect(callbacks.onSignInNeeded).toHaveBeenCalledTimes(1);
    expect(el.loads).toBe(0);
  });

  it('stops offering the document when the role was taken away', async () => {
    const { el, callbacks } = setup(() => json(403, {}));
    await expect(el.getToken!({ docId: 'doc-1' })).rejects.toThrow();
    el.fire('de-auth-required', {});
    expect(callbacks.onAccessLost).toHaveBeenCalledTimes(1);
    expect(el.loads).toBe(0);
  });

  it('loads the document again once when the token was refused, then gives up inside the window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    const { el, callbacks } = setup(() => json(200, { token: 't' }));
    await expect(el.getToken!({ docId: 'doc-1' })).resolves.toBe('t');
    el.fire('de-auth-required', {});
    expect(el.loads).toBe(1);
    expect(callbacks.onAccessLost).not.toHaveBeenCalled();
    vi.setSystemTime(new Date(Date.parse('2030-01-01T00:00:00Z') + AUTH_RETRY_WINDOW_MS - 1));
    el.fire('de-auth-required', {});
    expect(el.loads).toBe(1);
    expect(callbacks.onAccessLost).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date(Date.parse('2030-01-01T00:00:00Z') + AUTH_RETRY_WINDOW_MS + 1));
    el.fire('de-auth-required', {});
    expect(el.loads).toBe(2);
  });

  it('passes the message and the fatal flag of de-error to the page, and de-status to its indicator', () => {
    const { el, callbacks } = setup(() => json(200, {}));
    el.fire('de-error', { code: 'service_unavailable', message: 'Try again.', fatal: true });
    expect(callbacks.onError).toHaveBeenCalledWith({
      code: 'service_unavailable',
      message: 'Try again.',
      fatal: true,
    });
    el.fire('de-status', { connection: 'online', sync: 'saved' });
    expect(callbacks.onStatus).toHaveBeenCalledWith({ connection: 'online', sync: 'saved' });
  });

  it('opens the host share dialog on de-share-request', () => {
    const { el, callbacks } = setup(() => json(200, {}));
    el.fire('de-share-request', {});
    expect(callbacks.onShareRequest).toHaveBeenCalledTimes(1);
  });

  it('removes its listeners when detached', () => {
    const { el, callbacks, detach } = setup(() => json(200, {}));
    detach();
    el.fire('de-error', { code: 'x', message: 'y', fatal: false });
    el.fire('de-share-request', {});
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(callbacks.onShareRequest).not.toHaveBeenCalled();
  });
});

describe('flushBeforeNavigation (UX-093 criterion 3, the host side of the wait)', () => {
  it('reports unsupported when the element has no flush yet', async () => {
    const el = new FakeEditor();
    await expect(flushBeforeNavigation(el.asEditor(), 1500)).resolves.toBe('unsupported');
  });

  it('waits for flush with the timeout and reports flushed', async () => {
    const el = new FakeEditor();
    const flush = vi.fn(async () => {});
    el.flush = flush;
    await expect(flushBeforeNavigation(el.asEditor(), 1500)).resolves.toBe('flushed');
    expect(flush).toHaveBeenCalledWith({ timeoutMs: 1500 });
  });

  it('reports kept when flush rejects, so the host navigates and the work stays in the journal', async () => {
    const el = new FakeEditor();
    el.flush = async () => {
      throw new Error('timed out');
    };
    await expect(flushBeforeNavigation(el.asEditor(), 1500)).resolves.toBe('kept');
  });
});

describe('the guide comments of the glue (UX-093 criterion 5)', () => {
  it('gives every exported function a comment that points to the guide section that explains it', async () => {
    const source = await readFile(
      fileURLToPath(new URL('../src/lib/glue/page-glue.ts', import.meta.url)),
      'utf8',
    );
    const lines = source.split('\n');
    const exported = lines
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => /^export (async )?function /.test(line));
    expect(exported.length).toBeGreaterThanOrEqual(5);
    for (const { i, line } of exported) {
      const end = lines.lastIndexOf('/**', i);
      const close = lines.indexOf(' */', end);
      const comment = lines.slice(end, close + 1).join('\n');
      expect(end, line).toBeGreaterThanOrEqual(0);
      expect(comment, line).toContain('guide:');
    }
  });
});
