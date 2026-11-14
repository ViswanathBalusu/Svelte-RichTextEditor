// The host's document routes behind the share dialog and the document list (UX-095 criteria 2
// and 3; UX-094 criteria 2 and 3, their server halves), run through the route modules themselves
// against the real document service in memory. Only `host()` is replaced. The UI parts of those
// criteria (the dialog, the title slot, the list's live update) are not run here.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { changeRole, createFromTemplate } from '../src/lib/server/documents.ts';
import type * as HostModule from '../src/lib/server/host.ts';
import type { Host } from '../src/lib/server/host.ts';
import { SESSION_COOKIE } from '../src/lib/server/sessions.ts';
import { startHarness, type Harness } from './support.ts';

const current = vi.hoisted(() => ({ host: null as unknown }));

vi.mock('../src/lib/server/host.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof HostModule>()),
  host: async () => current.host,
}));

const DOC_PAGE = '../src/routes/as/[user]/docs/[id]/+page.server.ts';
const LIST_PAGE = '../src/routes/as/[user]/+page.server.ts';
const TOKEN_ROUTE = '../src/routes/as/[user]/api/token/+server.ts';

type Action = (event: unknown) => Promise<unknown>;
interface Actions {
  actions: Record<string, Action>;
}
interface TokenRoute {
  POST(event: unknown): Promise<Response>;
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

function signIn(host: Host, sub: string) {
  return cookiesFor(host.sessions.create(sub));
}

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
}

/**
 * Runs a named action. A SvelteKit redirect is thrown; it is returned as `{ redirect, status }`.
 * A SvelteKit `fail()` is returned as its `{ status, data }` object, as the action gives it.
 */
async function run(
  modulePath: string,
  name: string,
  sub: string,
  cookies: unknown,
  params: Record<string, string>,
  body: FormData,
): Promise<Record<string, unknown>> {
  const route = (await import(/* @vite-ignore */ modulePath)) as Actions;
  try {
    return (await route.actions[name]!({
      params: { user: sub, ...params },
      cookies,
      request: new Request('http://host.test/x', { method: 'POST', body }),
    })) as Record<string, unknown>;
  } catch (e) {
    const r = e as { status?: unknown; location?: unknown };
    if (typeof r.status === 'number' && typeof r.location === 'string')
      return { redirect: r.location, status: r.status };
    throw e;
  }
}

async function tokenFor(host: Host, sub: string, docId: string): Promise<Response> {
  const route = (await import(/* @vite-ignore */ TOKEN_ROUTE)) as TokenRoute;
  try {
    return await route.POST({
      params: { user: sub },
      cookies: signIn(host, sub),
      request: new Request('http://host.test/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docId }),
      }),
    });
  } catch (e) {
    const status = (e as { status?: unknown }).status;
    if (typeof status === 'number') return new Response(null, { status });
    throw e;
  }
}

async function setup(): Promise<{ harness: Harness; doc: string }> {
  const harness = await startHarness();
  current.host = harness.host;
  const template = harness.host.seed.templates.find((t) => t.key === 'two-regions')!;
  const entry = await createFromTemplate(harness.host, {
    template,
    title: 'Shared agreement',
    creator: 'u-olivia',
  });
  return { harness, doc: entry.id };
}

describe('the share dialog role change (UX-095 criteria 2 and 3, server side)', () => {
  it('taking a role away ends the person sessions now, the message says so, and the old token stops working', async () => {
    const { harness, doc } = await setup();
    h = harness;
    const issued = (await (await tokenFor(h.host, 'u-bob', doc)).json()) as { token: string };
    // The watermark is to the second (D73): wait so that the revocation is later than the token.
    await new Promise((r) => setTimeout(r, 1100));

    const result = await run(
      DOC_PAGE,
      'role',
      'u-olivia',
      signIn(h.host, 'u-olivia'),
      { id: doc },
      form({ sub: 'u-bob', role: 'none' }),
    );
    expect(result).toMatchObject({
      done: expect.stringContaining(
        'Their sessions on this document have ended, so the change applies now.',
      ),
    });
    expect(h.host.catalogue.roleOf(doc, 'u-bob')).toBeNull();
    await expect(h.service.tokens.verifyUser(issued.token)).rejects.toMatchObject({
      code: 'revoked',
    });
    expect((await tokenFor(h.host, 'u-bob', doc)).status).toBe(403);
  });

  it('giving a role to someone with none says the change applies from the next token, at most 15 minutes later', async () => {
    const { harness, doc } = await setup();
    h = harness;
    // Vic's role is taken away first (that ends his sessions), so that giving one back is a new role.
    await changeRole(h.host, doc, 'u-vic', null);
    expect(h.host.catalogue.roleOf(doc, 'u-vic')).toBeNull();
    const result = await run(
      DOC_PAGE,
      'role',
      'u-olivia',
      signIn(h.host, 'u-olivia'),
      { id: doc },
      form({ sub: 'u-vic', role: 'viewer' }),
    );
    expect(result).toMatchObject({
      done: expect.stringContaining(
        'The change applies from their next token, at most 15 minutes later.',
      ),
    });
    expect(h.host.catalogue.roleOf(doc, 'u-vic')).toBe('viewer');
  });

  it('changing an existing role (here a viewer raised to editor) ends the sessions now, as changeRole does', async () => {
    const { harness, doc } = await setup();
    h = harness;
    const result = await run(
      DOC_PAGE,
      'role',
      'u-olivia',
      signIn(h.host, 'u-olivia'),
      { id: doc },
      form({ sub: 'u-vic', role: 'editor' }),
    );
    expect(result).toMatchObject({
      done: expect.stringContaining('Their sessions on this document have ended'),
    });
    expect(h.host.catalogue.roleOf(doc, 'u-vic')).toBe('editor');
  });

  it('refuses a non-owner with 403, and an owner changing their own role with 400; nothing changes', async () => {
    const { harness, doc } = await setup();
    h = harness;
    const bob = await run(
      DOC_PAGE,
      'role',
      'u-bob',
      signIn(h.host, 'u-bob'),
      { id: doc },
      form({ sub: 'u-vic', role: 'editor' }),
    );
    expect(bob).toMatchObject({ status: 403 });
    expect(h.host.catalogue.roleOf(doc, 'u-vic')).toBe('viewer');

    const self = await run(
      DOC_PAGE,
      'role',
      'u-olivia',
      signIn(h.host, 'u-olivia'),
      { id: doc },
      form({ sub: 'u-olivia', role: 'editor' }),
    );
    expect(self).toMatchObject({ status: 400 });
    expect(h.host.catalogue.roleOf(doc, 'u-olivia')).toBe('owner');
  });
});

describe('the document list create, rename and delete (UX-094 criteria 2 and 3, server side)', () => {
  it('create makes the document through the service with the host externalId and redirects to it', async () => {
    const { harness } = await setup();
    h = harness;
    const result = await run(
      LIST_PAGE,
      'create',
      'u-olivia',
      signIn(h.host, 'u-olivia'),
      {},
      form({ template: 'two-regions', title: '  New   agreement ' }),
    );
    const entry = h.host.catalogue.listFor('u-olivia').find((d) => d.title === 'New agreement');
    expect(entry).toBeDefined();
    expect(result).toMatchObject({ redirect: `/as/u-olivia/docs/${entry!.id}`, status: 303 });
    const { doc } = await h.host.service.getDocument(entry!.id);
    expect(doc.title).toBe('New agreement');
    expect(entry!.externalId).toMatch(/^refhost-/);
    await expect(h.host.service.findByExternalId(entry!.externalId)).resolves.toMatchObject({
      id: entry!.id,
    });
  });

  it('rename changes the catalogue and the service title for the owner; a non-owner is refused', async () => {
    const { harness, doc } = await setup();
    h = harness;
    const refused = await run(
      LIST_PAGE,
      'rename',
      'u-bob',
      signIn(h.host, 'u-bob'),
      {},
      form({ id: doc, title: 'Bob renames' }),
    );
    expect(refused).toMatchObject({ status: 403 });
    expect(h.host.catalogue.get(doc)?.title).toBe('Shared agreement');

    const done = await run(
      LIST_PAGE,
      'rename',
      'u-olivia',
      signIn(h.host, 'u-olivia'),
      {},
      form({ id: doc, title: 'Renamed agreement' }),
    );
    expect(done).toMatchObject({ done: 'Renamed.' });
    expect(h.host.catalogue.get(doc)?.title).toBe('Renamed agreement');
    expect((await h.host.service.getDocument(doc)).doc.title).toBe('Renamed agreement');
    expect(h.host.catalogue.listFor('u-olivia').map((d) => d.title)).toContain('Renamed agreement');
  });

  it('delete is soft: the list drops it, the catalogue keeps it marked deleted, the service refuses it', async () => {
    const { harness, doc } = await setup();
    h = harness;
    const externalId = h.host.catalogue.get(doc)!.externalId;
    const done = await run(
      LIST_PAGE,
      'delete',
      'u-olivia',
      signIn(h.host, 'u-olivia'),
      {},
      form({ id: doc }),
    );
    expect(done).toMatchObject({ done: 'Deleted.' });
    expect(h.host.catalogue.listFor('u-olivia').some((d) => d.id === doc)).toBe(false);
    expect(h.host.catalogue.get(doc)).toBeNull();
    const kept = h.host.catalogue.byExternalId(externalId);
    expect(kept?.id).toBe(doc);
    expect(kept?.deletedAt).not.toBeNull();
    await expect(h.host.service.getDocument(doc)).rejects.toMatchObject({ code: 'not_found' });
  });
});
