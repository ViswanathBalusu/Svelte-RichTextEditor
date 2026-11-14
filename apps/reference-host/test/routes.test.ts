// The host's routes themselves (UX-095 criterion 5), run against the real document service in
// memory: the owner sets output restrictions through the editor page's `restrict` action, a
// non-owner is refused, and the token endpoint (`POST /as/<sub>/api/token`) then issues a token
// that carries `restrict`. Only `host()` is replaced, so that the routes use the test's host.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFromTemplate } from '../src/lib/server/documents.ts';
import type * as HostModule from '../src/lib/server/host.ts';
import type { Host } from '../src/lib/server/host.ts';
import { SESSION_COOKIE } from '../src/lib/server/sessions.ts';
import { decodeJws, startHarness, type Harness } from './support.ts';

const current = vi.hoisted(() => ({ host: null as unknown }));

vi.mock('../src/lib/server/host.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof HostModule>()),
  host: async () => current.host,
}));

// The route modules are loaded by path at run time: their `./$types` imports are SvelteKit's
// generated types, which this project's Node type-check does not see.
const TOKEN_ROUTE = '../src/routes/as/[user]/api/token/+server.ts';
const PAGE_ROUTE = '../src/routes/as/[user]/docs/[id]/+page.server.ts';

interface TokenRoute {
  POST(event: unknown): Promise<Response>;
}
interface PageRoute {
  actions: Record<string, (event: unknown) => Promise<unknown>>;
}

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
  current.host = null;
});

function cookiesFor(session: string) {
  return { get: (name: string) => (name === SESSION_COOKIE ? session : undefined) };
}

/** Signs `sub` in to the demo host, as the start page does. */
function signIn(host: Host, sub: string) {
  return cookiesFor(host.sessions.create(sub));
}

async function postToken(sub: string, cookies: unknown, docId: string): Promise<Response> {
  const route = (await import(/* @vite-ignore */ TOKEN_ROUTE)) as TokenRoute;
  try {
    return await route.POST({
      params: { user: sub },
      cookies,
      request: new Request('http://host.test/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docId }),
      }),
    });
  } catch (e) {
    // SvelteKit's `error()` throws an HttpError with a status.
    const status = (e as { status?: unknown }).status;
    if (typeof status === 'number') return new Response(null, { status });
    throw e;
  }
}

async function restrictAction(
  sub: string,
  cookies: unknown,
  docId: string,
  target: string,
  restrict: readonly string[],
): Promise<{ status?: number; data?: unknown } | Record<string, unknown>> {
  const route = (await import(/* @vite-ignore */ PAGE_ROUTE)) as PageRoute;
  const form = new FormData();
  form.set('sub', target);
  for (const r of restrict) form.append('restrict', r);
  return (await route.actions['restrict']!({
    params: { user: sub, id: docId },
    cookies,
    request: new Request('http://host.test/docs?/restrict', { method: 'POST', body: form }),
  })) as Record<string, unknown>;
}

async function setup(): Promise<{ harness: Harness; doc: string }> {
  const harness = await startHarness();
  current.host = harness.host;
  const template = harness.host.seed.templates.find((t) => t.key === 'two-regions')!;
  const entry = await createFromTemplate(harness.host, {
    template,
    title: 'Restricted agreement',
    creator: 'u-olivia',
  });
  return { harness, doc: entry.id };
}

describe('output restrictions through the routes (UX-095 criterion 5)', () => {
  it("the owner's action sets them, and the token endpoint's next token carries restrict", async () => {
    const { harness, doc } = await setup();
    h = harness;
    const ada = signIn(h.host, 'u-ada');

    // Before: Ada's token has no `restrict`.
    const before = await postToken('u-ada', ada, doc);
    expect(before.status).toBe(200);
    const first = (await before.json()) as { token: string };
    expect(decodeJws(first.token).payload['restrict']).toBeUndefined();

    // The owner sets two restrictions on Ada through the editor page's action.
    const olivia = signIn(h.host, 'u-olivia');
    const result = await restrictAction('u-olivia', olivia, doc, 'u-ada', [
      'no-export',
      'no-print',
    ]);
    expect(result).toMatchObject({ done: expect.stringContaining('next token') });

    // Ada's next token, from the token endpoint itself, carries them; the service reads them back.
    const after = await postToken('u-ada', ada, doc);
    expect(after.status).toBe(200);
    expect(after.headers.get('Cache-Control')).toBe('no-store');
    const next = (await after.json()) as { token: string };
    expect(decodeJws(next.token).payload['restrict']).toEqual(['no-export', 'no-print']);
    await expect(h.service.tokens.verifyUser(next.token)).resolves.toMatchObject({
      sub: 'u-ada',
      restrict: ['no-export', 'no-print'],
    });

    // Clearing them: the next token has none again.
    await restrictAction('u-olivia', olivia, doc, 'u-ada', []);
    const cleared = (await (await postToken('u-ada', ada, doc)).json()) as { token: string };
    expect(decodeJws(cleared.token).payload['restrict']).toBeUndefined();
  });

  it('refuses a person who is not the owner with 403 and changes nothing', async () => {
    const { harness, doc } = await setup();
    h = harness;
    // u-bob is an editor on the document, not its owner.
    const bob = signIn(h.host, 'u-bob');
    const result = await restrictAction('u-bob', bob, doc, 'u-ada', ['no-copy']);
    expect(result).toMatchObject({ status: 403 });
    expect(h.host.catalogue.get(doc)?.restrict?.['u-ada']).toBeUndefined();
    const ada = signIn(h.host, 'u-ada');
    const token = (await (await postToken('u-ada', ada, doc)).json()) as { token: string };
    expect(decodeJws(token.token).payload['restrict']).toBeUndefined();
  });

  it('refuses a name outside the three with 400', async () => {
    const { harness, doc } = await setup();
    h = harness;
    const olivia = signIn(h.host, 'u-olivia');
    const result = await restrictAction('u-olivia', olivia, doc, 'u-ada', ['no-share']);
    expect(result).toMatchObject({ status: 400 });
    expect(h.host.catalogue.get(doc)?.restrict?.['u-ada']).toBeUndefined();
  });

  it('the token endpoint answers 401 without a session and 403 without a role', async () => {
    const { harness, doc } = await setup();
    h = harness;
    expect((await postToken('u-ada', cookiesFor('not-a-session'), doc)).status).toBe(401);
    expect((await postToken('u-ada', signIn(h.host, 'u-ada'), 'no-such-doc')).status).toBe(403);
  });
});
