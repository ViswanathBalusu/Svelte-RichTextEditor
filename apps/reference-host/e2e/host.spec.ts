/**
 * The reference host's own behaviour against the demo stack (UX-092, UX-093, UX-094): the demo
 * sign-in, accessibility of its pages, what the browser never sees, the page glue's directory
 * callbacks, token renewal, revocation when a role is taken away, rename and soft delete, and the
 * parts of the page glue that wait for the element (marked `test.fail` with the reason).
 */
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
  dataDir,
  HOST_ISSUER,
  readSecrets,
  seedTenant,
  setting,
  stackSettings,
} from '../scripts/lib/stack.ts';
import { hostSigned } from '../src/lib/server/tokens.ts';
import {
  eventsOf,
  hostUrl,
  openDocument,
  PEOPLE,
  recordEvents,
  serviceUrl,
  signIn,
} from './support.ts';

const RUN = Date.now().toString(36);

interface CatalogueFile {
  documents: Array<{ id: string; externalId: string; deletedAt: string | null }>;
}

function catalogue(): CatalogueFile {
  return JSON.parse(readFileSync(join(dataDir(), 'catalogue.json'), 'utf8')) as CatalogueFile;
}

test("the tenant's key and allowed origins come from the stack's configuration; its secrets are marked demo-only (UX-091 criteria 3, 4; BE-005 criterion 2)", async () => {
  const s = stackSettings();
  const secrets = await readSecrets();
  expect(secrets['x-note']).toMatch(/^Demo only/);
  const seeded = catalogue().documents.find((d) => d.externalId === 'demo-supply-agreement');
  expect(seeded, 'the seeded document').toBeDefined();
  // A token signed with the host's key, registered from the stack's configuration, is accepted.
  const issuer = hostSigned({
    signing: { privateJwk: secrets.hostSigning, kid: secrets.hostSigning.kid, issuer: HOST_ISSUER },
    tenant: seedTenant().id,
    serviceId: setting(s, 'DOCEDIT_DEMO_SERVICE_ID'),
    seconds: 60,
  });
  const { token } = await issuer.issue({
    user: { sub: PEOPLE.olivia.sub, name: PEOPLE.olivia.name, groups: [], about: '' },
    doc: seeded!.id,
    role: 'owner',
  });
  const read = await fetch(`${serviceUrl()}/v1/documents/${seeded!.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(read.status).toBe(200);
  // The host's origin is allowed; any other is granted nothing (05 §6.1; 10 §3.2).
  const discovery = `${serviceUrl()}/.well-known/dep`;
  const allowed = await fetch(discovery, { headers: { Origin: hostUrl() } });
  expect(allowed.headers.get('access-control-allow-origin')).toBe(hostUrl());
  const other = await fetch(discovery, { headers: { Origin: 'https://not-registered.invalid' } });
  expect(other.headers.get('access-control-allow-origin')).toBeNull();
});

async function newPerson(browser: Browser) {
  const context = await browser.newContext();
  await recordEvents(context);
  return { context, page: await context.newPage() };
}

/** Creates a document from the template as Olivia and returns its identifier. */
async function createDocument(page: Page, title: string): Promise<string> {
  await signIn(page, PEOPLE.olivia);
  await page.getByLabel('Title', { exact: true }).fill(title);
  await page.getByRole('button', { name: 'Create and open' }).click();
  await expect(page).toHaveURL(/\/docs\/[0-9a-f-]{36}$/);
  return page.url().split('/').pop()!;
}

test('the demo sign-in asks no password and is marked demo-only (UX-092 criterion 1)', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('note')).toContainText('Demo only');
  await expect(page.getByRole('note')).toContainText('not a production deployment');
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await signIn(page, PEOPLE.vic);
  await expect(page.getByRole('note')).toContainText('Demo only');
});

test('two people in two tabs of one browser keep their own sessions', async ({ context }) => {
  const a = await context.newPage();
  const b = await context.newPage();
  await signIn(a, PEOPLE.ada);
  await signIn(b, PEOPLE.bob);
  await a.reload();
  await expect(a.getByTestId('acting-as')).toHaveText(PEOPLE.ada.name);
  await expect(b.getByTestId('acting-as')).toHaveText(PEOPLE.bob.name);
  // A path of a person this browser did not choose leads back to the start page.
  await a.goto('/as/u-vic/');
  await expect(a).toHaveURL(`${hostUrl()}/`);
});

test('the sign-in and the document list work with the keyboard and axe finds no violation (UX-094 criterion 6)', async ({
  page,
}) => {
  await page.goto('/');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  // Keyboard only: tab to Ada's button and press Enter.
  const target = page.getByRole('button', { name: `Continue as ${PEOPLE.ada.name}` });
  for (let i = 0; i < 20 && !(await target.evaluate((el) => el === document.activeElement)); i++)
    await page.keyboard.press('Tab');
  await expect(target).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/as\/u-ada\/?$/);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  const link = page.getByRole('link', { name: 'Supply agreement (demo)' });
  for (let i = 0; i < 30 && !(await link.evaluate((el) => el === document.activeElement)); i++)
    await page.keyboard.press('Tab');
  await expect(link).toBeFocused();
});

test.describe('in the editor', () => {
  let ada: { context: BrowserContext; page: Page };
  let olivia: { context: BrowserContext; page: Page };
  let docId = '';
  const tokens: string[] = [];
  const serviceRequests: Array<{ method: string; url: string }> = [];
  const hostBodies: string[] = [];

  test.beforeAll(async ({ browser }) => {
    olivia = await newPerson(browser);
    docId = await createDocument(olivia.page, `Host checks ${RUN}`);
    ada = await newPerson(browser);
    ada.page.on('request', (r) => {
      if (r.url().startsWith(serviceUrl()))
        serviceRequests.push({ method: r.method(), url: r.url() });
    });
    ada.page.on('response', async (r) => {
      if (!r.url().startsWith(hostUrl())) return;
      const body = await r.text().catch(() => '');
      hostBodies.push(body);
      if (r.url().endsWith('/api/token') && r.ok())
        tokens.push((JSON.parse(body) as { token: string }).token);
    });
    await signIn(ada.page, PEOPLE.ada);
    await openDocument(ada.page, PEOPLE.ada, docId);
  });

  test.afterAll(async () => {
    await ada?.context.close();
    await olivia?.context.close();
  });

  test('the token stays out of URLs, logs and browser storage; no secret reaches the browser (UX-092 criterion 3)', async () => {
    expect(tokens.length).toBeGreaterThan(0);
    const urls = [...serviceRequests.map((r) => r.url), ada.page.url()];
    for (const t of tokens) for (const u of urls) expect(u).not.toContain(t);
    const stored = await ada.page.evaluate(() =>
      JSON.stringify({
        local: { ...localStorage },
        session: { ...sessionStorage },
        cookie: document.cookie,
      }),
    );
    for (const t of tokens) expect(stored).not.toContain(t);
    // The session cookie is HttpOnly: the page cannot read it.
    expect(stored).not.toContain('docedit_demo_session');
    const logs = [
      'reference-host.log',
      'reference-host.err.log',
      'document-service.log',
      'document-service.err.log',
    ]
      .map((f) => {
        try {
          return readFileSync(join(dataDir(), 'logs', f), 'utf8');
        } catch {
          return '';
        }
      })
      .join('\n');
    for (const t of tokens) expect(logs).not.toContain(t);
    // Neither the host's private key nor its API key is in anything the host sent to the browser.
    const secrets = await readSecrets();
    const all = hostBodies.join('\n');
    expect(all).not.toContain(String(secrets.hostSigning.d));
    expect(all).not.toContain(secrets.apiKey.secret);
  });

  test('the editor never lists or searches documents; only the host does (UX-094 criterion 5)', async () => {
    expect(serviceRequests.length).toBeGreaterThan(0);
    const listing = serviceRequests.filter(
      (r) => /\/v1\/documents\/?(\?|$)/.test(r.url) || /\/v1\/search(\?|$)/.test(r.url),
    );
    expect(listing).toEqual([]);
  });

  test('the page glue answers resolveUsers and searchPrincipals from the host directory (UX-093 criterion 1)', async () => {
    const answers = await ada.page.evaluate(async (doc) => {
      const el = document.querySelector('doc-editor') as unknown as {
        resolveUsers(ids: string[]): Promise<unknown>;
        searchPrincipals(q: { text: string; docId: string; purpose: string }): Promise<unknown>;
        getToken(ctx: { docId: string }): Promise<string>;
      };
      return {
        users: await el.resolveUsers(['u-bob', 'nobody']),
        found: await el.searchPrincipals({ text: 'lind', docId: doc, purpose: 'grant' }),
        token: typeof (await el.getToken({ docId: doc })),
      };
    }, docId);
    expect(answers.users).toEqual([{ id: 'u-bob', name: PEOPLE.bob.name }, null]);
    expect(answers.found).toEqual([{ principal: 'user:u-ada', name: PEOPLE.ada.name }]);
    expect(answers.token).toBe('string');
  });

  test('the element asks for a new token before the old one expires, without the person doing anything (UX-092 criterion 5)', async () => {
    const seconds = Number(setting(stackSettings(), 'DOCEDIT_DEMO_TOKEN_SECONDS'));
    test.skip(
      seconds > 120,
      `the stack's tokens live ${seconds} s; start it with DOCEDIT_DEMO_TOKEN_SECONDS=75 to watch a renewal`,
    );
    test.setTimeout((seconds + 60) * 1000);
    const before = tokens.length;
    // The service sends auth.expiring about 60 s before expiry (05 §5.1); the element then calls getToken.
    await expect
      .poll(() => tokens.length, { timeout: (seconds + 30) * 1000, intervals: [2000] })
      .toBeGreaterThan(before);
    expect(await eventsOf(ada.page, 'de-auth-required')).toEqual([]);
  });

  test('the host toolbar uses queryCommand, exec and de-command-state (UX-093 criterion 4)', async () => {
    test.fail(
      true,
      'Expected to fail: the element offers no queryCommand, exec or de-command-state yet (PRO-085, phase 1b; packet B2).',
    );
    await expect(
      ada.page.getByRole('toolbar', { name: 'Host toolbar' }).getByRole('button'),
    ).toHaveCount(4, {
      timeout: 5000,
    });
  });

  test('before the host navigates it awaits flush (UX-093 criterion 3)', async () => {
    test.fail(
      true,
      'Expected to fail: the element offers no flush({ timeoutMs }) yet (PRO-083, phase 1b; packet B2).',
    );
    await ada.page.getByRole('link', { name: 'Documents' }).click();
    await expect(ada.page.getByText('Last flush: flushed')).toBeVisible({ timeout: 5000 });
  });
});

test('a role taken away in the host cuts the person off before the token expires (UX-092 criterion 4; UX-093 criterion 2)', async ({
  browser,
}) => {
  const olivia = await newPerson(browser);
  const vic = await newPerson(browser);
  try {
    const docId = await createDocument(olivia.page, `Revocation ${RUN}`);
    await signIn(vic.page, PEOPLE.vic);
    await openDocument(vic.page, PEOPLE.vic, docId);
    // Olivia takes Vic's role away in the host's panel: the host calls POST /sessions/revoke.
    const row = olivia.page.locator('tr[data-person="u-vic"]');
    await row.getByLabel(`Role of ${PEOPLE.vic.name}`).selectOption('none');
    await row.getByRole('button', { name: 'Save' }).click();
    await expect(olivia.page.getByTestId('host-done')).toContainText('without access');
    // Vic's open editor is closed by the service and the host explains it (de-auth-required).
    await expect
      .poll(async () => (await eventsOf(vic.page, 'de-auth-required')).length, { timeout: 30_000 })
      .toBeGreaterThan(0);
    await expect(vic.page.getByTestId('host-problem')).toContainText('no longer have access');
    // And the host's list no longer shows the document to Vic.
    await vic.page.goto('/as/u-vic/');
    await expect(vic.page.getByRole('link', { name: `Revocation ${RUN}` })).toHaveCount(0);
  } finally {
    await olivia.context.close();
    await vic.context.close();
  }
});

test('a rename shows in the title slot; a delete is soft in the host and in the service (UX-094 criterion 3)', async ({
  browser,
}) => {
  const olivia = await newPerson(browser);
  try {
    const title = `Rename me ${RUN}`;
    const docId = await createDocument(olivia.page, title);
    await openDocument(olivia.page, PEOPLE.olivia, docId);
    await expect(olivia.page.getByTestId('title-slot')).toHaveText(title);
    await olivia.page.getByLabel('Title', { exact: true }).fill(`Renamed ${RUN}`);
    await olivia.page.getByRole('button', { name: 'Rename' }).click();
    await expect(olivia.page.getByTestId('title-slot')).toHaveText(`Renamed ${RUN}`);
    // The editor stayed loaded through the rename (the form does not reload the page).
    expect((await eventsOf(olivia.page, 'de-ready')).length).toBe(1);
    // Delete it from the list in a second tab while the editor is still open in the first.
    const list = await olivia.context.newPage();
    await list.goto('/as/u-olivia/');
    const row = list.locator(`tr[data-document="${docId}"]`);
    await expect(row.getByRole('link')).toHaveText(`Renamed ${RUN}`);
    await row.getByRole('button', { name: `Delete Renamed ${RUN}` }).click();
    await expect(list.locator(`tr[data-document="${docId}"]`)).toHaveCount(0);
    // The open editor is closed by the service; the page shows the element's de-error message
    // and, for a fatal one, offers to load again (UX-093 criterion 2).
    await expect
      .poll(async () => (await eventsOf(olivia.page, 'de-error')).length, { timeout: 30_000 })
      .toBeGreaterThan(0);
    const error = (await eventsOf(olivia.page, 'de-error')).at(-1)!.detail as {
      message: string;
      fatal: boolean;
    };
    await expect(olivia.page.getByTestId('host-problem')).toContainText(error.message);
    await expect(olivia.page.getByRole('button', { name: 'Load the document again' })).toHaveCount(
      error.fatal ? 1 : 0,
    );
    // Soft: the host's catalogue keeps the row with its deletion time; the service refuses the document.
    expect(catalogue().documents.find((d) => d.id === docId)?.deletedAt).toEqual(
      expect.any(String),
    );
    const secrets = await readSecrets();
    const r = await fetch(`${serviceUrl()}/v1/documents/${docId}`, {
      headers: { Authorization: `Bearer ${secrets.apiKey.credential}` },
    });
    expect(r.status).toBe(404);
  } finally {
    await olivia.context.close();
  }
});
