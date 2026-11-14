// The share dialog and the demo sign-in through the route modules, against the document service in
// memory (only `host()` is replaced). Covers: the role action takes `filler` and stores it; the
// owner's load gives the groups with their members; the start page signs a visitor in as the chosen
// seeded person with no password, and marks the page demo-only (UX-092 criterion 1); the dialog
// has no region-grant forms (UX-095 criterion 4, in its markup). The rendered dialog and the focus
// behaviour (UX-095 criterion 6) are not run here: no browser.
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFromTemplate } from '../src/lib/server/documents.ts';
import type * as HostModule from '../src/lib/server/host.ts';
import type { Host } from '../src/lib/server/host.ts';
import { SESSION_COOKIE, userPath } from '../src/lib/server/sessions.ts';
import { startHarness, type Harness } from './support.ts';

const current = vi.hoisted(() => ({ host: null as unknown }));

vi.mock('../src/lib/server/host.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof HostModule>()),
  host: async () => current.host,
}));

const DOC_PAGE = '../src/routes/as/[user]/docs/[id]/+page.server.ts';
const START_PAGE = '../src/routes/+page.server.ts';

interface Actions {
  actions: Record<string, (event: unknown) => Promise<unknown>>;
}
interface Loader {
  load(event: unknown): Promise<{ owner: { groups: unknown } }>;
}

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
  current.host = null;
});

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
}

function signIn(host: Host, sub: string) {
  const id = host.sessions.create(sub);
  return { get: (name: string) => (name === SESSION_COOKIE ? id : undefined) };
}

async function setup(): Promise<{ harness: Harness; doc: string }> {
  const harness = await startHarness();
  current.host = harness.host;
  h = harness;
  const template = harness.host.seed.templates.find((t) => t.key === 'two-regions')!;
  const entry = await createFromTemplate(harness.host, {
    template,
    title: 'Shared agreement',
    creator: 'u-olivia',
  });
  return { harness, doc: entry.id };
}

describe('the share dialog role action with filler (UX-095 criterion 1, server side)', () => {
  it('stores the filler role for a person and says when it takes effect', async () => {
    const { harness, doc } = await setup();
    const route = (await import(/* @vite-ignore */ DOC_PAGE)) as Actions;
    const result = await route.actions['role']!({
      params: { user: 'u-olivia', id: doc },
      cookies: signIn(harness.host, 'u-olivia'),
      request: new Request('http://host.test/x', {
        method: 'POST',
        body: form({ sub: 'u-vic', role: 'filler' }),
      }),
    });
    expect(harness.host.catalogue.roleOf(doc, 'u-vic')).toBe('filler');
    // Vic was a viewer: changing an existing role ends the sessions now (changeRole), so the
    // message says the change applies now, not at the next token.
    expect(result).toEqual({
      done: 'Vic Moreau is now filler. Their sessions on this document have ended, so the change applies now.',
    });
  });

  it('refuses a role outside the six, and changes nothing', async () => {
    const { harness, doc } = await setup();
    const route = (await import(/* @vite-ignore */ DOC_PAGE)) as Actions;
    const result = (await route.actions['role']!({
      params: { user: 'u-olivia', id: doc },
      cookies: signIn(harness.host, 'u-olivia'),
      request: new Request('http://host.test/x', {
        method: 'POST',
        body: form({ sub: 'u-vic', role: 'administrator' }),
      }),
    })) as { status: number };
    expect(result.status).toBe(400);
    expect(harness.host.catalogue.roleOf(doc, 'u-vic')).toBe('viewer');
  });
});

describe('the owner load gives the share dialog its groups (UX-095 criterion 1)', () => {
  it('lists the seeded groups with the members and their document roles', async () => {
    const { harness, doc } = await setup();
    const route = (await import(/* @vite-ignore */ DOC_PAGE)) as unknown as Loader;
    const data = await route.load({
      params: { id: doc },
      parent: async () => ({ person: { sub: 'u-olivia', name: 'Olivia Okafor' } }),
    });
    const byId = Object.fromEntries(
      (data['owner'].groups as Array<{ id: string; members: unknown[] }>).map((g) => [g.id, g]),
    );
    expect(Object.keys(byId).sort()).toEqual(harness.host.directory.groups.map((g) => g.id).sort());
    expect(byId['g-finance']!.members).toEqual([
      { sub: 'u-ada', name: 'Ada Lindqvist', role: 'editor' },
    ]);
    expect(byId['g-owners']!.members).toEqual([
      { sub: 'u-olivia', name: 'Olivia Okafor', role: 'owner' },
    ]);
  });
});

describe('the demo sign-in (UX-092 criterion 1)', () => {
  it('starts a session for the chosen seeded person with no password, scoped to that person path', async () => {
    const { harness } = await setup();
    const route = (await import(/* @vite-ignore */ START_PAGE)) as Actions;
    const set = vi.fn();
    let redirected: unknown = null;
    try {
      await route.actions['signin']!({
        cookies: { set },
        url: new URL('http://host.test/'),
        request: new Request('http://host.test/', { method: 'POST', body: form({ sub: 'u-ada' }) }),
      });
    } catch (e) {
      redirected = e;
    }
    // No trailing slash: a 308 after this 303 makes WebKit replay the POST (lane U-UX-091-104, round 9).
    expect(redirected).toMatchObject({ status: 303, location: userPath('u-ada') });
    expect(set).toHaveBeenCalledTimes(1);
    const [name, value, options] = set.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(name).toBe(SESSION_COOKIE);
    expect(options).toMatchObject({ path: userPath('u-ada'), httpOnly: true, sameSite: 'strict' });
    expect(harness.host.sessions.check(value, 'u-ada')).not.toBeNull();
    expect(harness.host.sessions.check(value, 'u-bob')).toBeNull();
  });

  it('refuses a choice that is not a seeded person, and starts no session', async () => {
    await setup();
    const route = (await import(/* @vite-ignore */ START_PAGE)) as Actions;
    const set = vi.fn();
    const result = (await route.actions['signin']!({
      cookies: { set },
      url: new URL('http://host.test/'),
      request: new Request('http://host.test/', {
        method: 'POST',
        body: form({ sub: 'someone@example.com' }),
      }),
    })) as { status: number };
    expect(result.status).toBe(400);
    expect(set).not.toHaveBeenCalled();
  });

  it('the start page is marked demo-only and asks for no password (markup, read from source)', async () => {
    const page = await readFile(new URL('../src/routes/+page.svelte', import.meta.url), 'utf8');
    expect(page).toContain('data-testid="demo-only"');
    expect(page).toContain('Demo only.');
    expect(page).toContain('No password is asked for.');
    expect(page).not.toMatch(/type=["']password["']/);
  });
});

describe('the share dialog markup (UX-095 criterion 4, read from source)', () => {
  it('has no region-grant or workflow forms, and points to the editor permissions pane', async () => {
    const dialog = await readFile(
      new URL('../src/lib/share/ShareDialog.svelte', import.meta.url),
      'utf8',
    );
    expect(dialog).toContain('<dialog');
    expect(dialog).toContain('permissions pane');
    expect(dialog).not.toContain('?/grant');
    expect(dialog).not.toMatch(/\?\/workflow/);
  });
});
