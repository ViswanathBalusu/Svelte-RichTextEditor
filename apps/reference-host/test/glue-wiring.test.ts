// The page glue wired to the host's own routes (UX-093 criterion 1): `getToken` posts to the token
// endpoint and gets a token the service accepts; `resolveUsers` and `searchPrincipals` post to the
// directory route and get names from the seeded directory. Only `host()` is replaced, so the routes
// run as they do in the server; the glue's `fetch` is an adapter that calls the route's POST.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tokenSource, directoryResolver, principalSearch } from '../src/lib/glue/page-glue.ts';
import { createFromTemplate } from '../src/lib/server/documents.ts';
import type * as HostModule from '../src/lib/server/host.ts';
import type { Host } from '../src/lib/server/host.ts';
import { SESSION_COOKIE } from '../src/lib/server/sessions.ts';
import { startHarness, type Harness } from './support.ts';

const current = vi.hoisted(() => ({ host: null as unknown }));

vi.mock('../src/lib/server/host.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof HostModule>()),
  host: async () => current.host,
}));

// Loaded by path at run time (their `./$types` imports are SvelteKit's generated types).
const TOKEN_ROUTE = '../src/routes/as/[user]/api/token/+server.ts';
const DIRECTORY_ROUTE = '../src/routes/as/[user]/api/directory/+server.ts';

interface PostRoute {
  POST(event: unknown): Promise<Response>;
}

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
  current.host = null;
});

/**
 * A `fetch` that answers by calling the route's POST with the request the glue made. A SvelteKit
 * `error()` is an HttpError with a status, which becomes the response's status.
 */
function routeFetch(route: PostRoute, user: string, session: string | null): typeof fetch {
  const cookies = {
    get: (name: string) => (name === SESSION_COOKIE ? (session ?? undefined) : undefined),
  };
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(String(input), init);
    try {
      return await route.POST({ params: { user }, cookies, request });
    } catch (e) {
      const status = (e as { status?: unknown }).status;
      if (typeof status === 'number') return new Response(null, { status });
      throw e;
    }
  }) as typeof fetch;
}

async function setup(): Promise<{ harness: Harness; doc: string; host: Host }> {
  const harness = await startHarness();
  current.host = harness.host;
  const template = harness.host.seed.templates.find((t) => t.key === 'two-regions')!;
  const entry = await createFromTemplate(harness.host, {
    template,
    title: 'Glue agreement',
    creator: 'u-olivia',
  });
  return { harness, doc: entry.id, host: harness.host };
}

describe('the page glue against the host routes (UX-093 criterion 1)', () => {
  it('getToken: the glue asks the token route for a token the document service accepts', async () => {
    const { harness, doc, host } = await setup();
    h = harness;
    const session = host.sessions.create('u-ada');
    const api = 'http://host.test/as/u-ada/api';
    const route = (await import(/* @vite-ignore */ TOKEN_ROUTE)) as PostRoute;
    const refusals: Array<string | null> = [];
    const getToken = tokenSource(api, (r) => refusals.push(r), routeFetch(route, 'u-ada', session));
    const token = await getToken({ docId: doc });
    const identity = await harness.service.tokens.verifyUser(token);
    expect(identity).toMatchObject({ sub: 'u-ada' });
    expect(identity.docs[doc]).toBe('editor');
    expect(refusals).toEqual([null]);
  });

  it('getToken: a visitor without a session is refused as a session problem, and nothing is issued', async () => {
    const { harness, doc } = await setup();
    h = harness;
    const api = 'http://host.test/as/u-ada/api';
    const route = (await import(/* @vite-ignore */ TOKEN_ROUTE)) as PostRoute;
    const refusals: Array<string | null> = [];
    const getToken = tokenSource(
      api,
      (r) => refusals.push(r),
      routeFetch(route, 'u-ada', 'no-such-session'),
    );
    await expect(getToken({ docId: doc })).rejects.toThrow(/session/);
    expect(refusals).toEqual(['session']);
  });

  it('resolveUsers: the directory route names the seeded identifiers, in order, null when unknown', async () => {
    const { harness, host } = await setup();
    h = harness;
    const session = host.sessions.create('u-ada');
    const route = (await import(/* @vite-ignore */ DIRECTORY_ROUTE)) as PostRoute;
    const resolve = directoryResolver(
      'http://host.test/as/u-ada/api',
      routeFetch(route, 'u-ada', session),
    );
    await expect(resolve(['u-bob', 'nobody', 'u-ada'])).resolves.toEqual([
      { id: 'u-bob', name: 'Bob Mensah' },
      null,
      { id: 'u-ada', name: 'Ada Lindqvist' },
    ]);
  });

  it('searchPrincipals: the directory route finds seeded people and groups by name', async () => {
    const { harness, host, doc } = await setup();
    h = harness;
    const session = host.sessions.create('u-ada');
    const route = (await import(/* @vite-ignore */ DIRECTORY_ROUTE)) as PostRoute;
    const search = principalSearch(
      'http://host.test/as/u-ada/api',
      routeFetch(route, 'u-ada', session),
    );
    const found = await search({ text: 'bo', docId: doc, purpose: 'grant' } as Parameters<
      typeof search
    >[0]);
    expect(found).toEqual([{ principal: 'user:u-bob', name: 'Bob Mensah' }]);
    const groups = await search({
      text: 'fin',
      kinds: ['group'],
      docId: doc,
      purpose: 'grant',
    } as Parameters<typeof search>[0]);
    expect(groups.map((p) => p.principal)).toEqual(['group:g-finance']);
  });

  it('the directory route refuses a visitor without a session', async () => {
    const { harness } = await setup();
    h = harness;
    const route = (await import(/* @vite-ignore */ DIRECTORY_ROUTE)) as PostRoute;
    const resolve = directoryResolver(
      'http://host.test/as/u-ada/api',
      routeFetch(route, 'u-ada', 'no-such-session'),
    );
    await expect(resolve(['u-bob'])).rejects.toThrow(/401/);
  });
});
