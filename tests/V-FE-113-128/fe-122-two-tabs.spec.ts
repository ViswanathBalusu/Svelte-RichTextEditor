/**
 * FE-122 criterion 3 (lane V-FE-113-128): the smoke suite drives the element from two tabs with
 * different grants on one real document service. The service is the one in services/document-service
 * (startService on PostgreSQL, in a database this file creates and drops). Each tab holds its own
 * user token: `ada` with the editor role and `grace` with the editor role on the same document, as
 * two people. Requests from the page reach the service through Playwright's routing (CORS is added
 * to the routed responses; the service itself is unchanged).
 *
 * Skips, with the reason, when PostgreSQL is not up (infra/test-env.ps1 up).
 */
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { configFromEnv } from '../../services/document-service/src/config.ts';
import { hashSecret } from '../../services/document-service/src/control-plane/tenants.ts';
import { newApiKey } from '../../services/document-service/src/control-plane/tokens.ts';
import { startService, type Service } from '../../services/document-service/src/server.ts';
import { documentWithRegions } from '../../services/document-service/test/control-plane/support.ts';
import {
  createTestDatabase,
  postgresUnavailable,
  type TestDatabase,
} from '../../services/document-service/test/support/env.ts';

const TENANT_NAME = 'V-FE-113-128 two tabs';
const PAGE_ORIGIN = 'http://127.0.0.1:57078';
const skip = await postgresUnavailable();
test.describe.configure({ mode: 'serial' });
test.skip(skip !== null, skip ?? '');

let db: TestDatabase;
let service: Service;
let docId: string;
let tokenAda: string;
let tokenGrace: string;

test.beforeAll(async () => {
  db = await createTestDatabase();
  const c = db.serviceConfig;
  const databaseUrl = `postgres://${c.user}:${c.password}@${c.host}:${c.port}/${c.database}`;
  await db.service.end();
  service = await startService({
    config: { ...configFromEnv({}), port: 0, workers: 1, databaseUrl, externalWorkers: true },
  });
  expect(await service.ready()).toMatchObject({ ready: true });

  const tenant = randomUUID();
  await service.parts.registry.putTenant(tenant, TENANT_NAME);
  const key = newApiKey(tenant);
  await service.parts.registry.addApiKey(tenant, {
    id: key.id,
    secretHash: hashSecret(key.secret),
  });
  // The demo page's origin (playwright.config.ts): the data plane refuses other origins (D66).
  await service.parts.registry.addOrigin(tenant, PAGE_ORIGIN);

  const created = await fetch(`${service.url}/v1/documents`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key.credential}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: documentWithRegions() }),
  });
  expect(created.status).toBe(201);
  docId = ((await created.json()) as { id: string }).id;

  tokenAda = (
    await service.tokens.mint(tenant, { sub: 'ada', docs: { [docId]: 'editor' }, name: 'Ada' })
  ).token;
  tokenGrace = (
    await service.tokens.mint(tenant, { sub: 'grace', docs: { [docId]: 'editor' }, name: 'Grace' })
  ).token;
});

test.afterAll(async () => {
  await service?.close();
  await db?.drop();
});

/** Routes the page's requests to the service: REST with CORS, the /dep WebSocket through. */
async function reachService(page: Page): Promise<void> {
  const origin = service.url;
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization,content-type,if-match,traceparent',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-expose-headers': 'etag,location,content-type',
  };
  await page.route(`${origin}/**`, async (route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), ...cors } });
  });
  const wsOrigin = origin.replace(/^http/, 'ws').replace(/\./g, '\\.');
  await page.routeWebSocket(new RegExp(`^${wsOrigin}/dep`), (ws) => ws.connectToServer());
}

/** Opens one tab on the document as `sub`, with that user's token, and waits for `de-ready`. */
async function openTab(page: Page, sub: string, token: string): Promise<void> {
  await reachService(page);
  await page.addInitScript(
    (cfg) => {
      (window as unknown as { __fe122: unknown }).__fe122 = cfg;
    },
    { endpoint: service.url, docId, token, sub },
  );
  await page.goto('/pages/fe-122-two-tabs.html');
  const status = () =>
    page.evaluate(() => (window as unknown as { __fe122Status: string }).__fe122Status);
  await expect.poll(status, { timeout: 30_000 }).not.toBe('loading');
  const state = await status();
  if (state !== 'ready') {
    const detail = await page.evaluate(
      () => (window as unknown as { __fe122Error?: string }).__fe122Error ?? '',
    );
    throw new Error(`the element did not become ready: ${state} ${detail}`);
  }
}

/** The text of the editing surface in the tab, with the shadow root pierced. */
function bodyText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const surface = document
      .querySelector('doc-editor')
      ?.shadowRoot?.querySelector('.de-editing-surface');
    return surface?.textContent ?? '';
  });
}

test('two tabs on one service type, select, undo and edit the same document', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const ada = await context.newPage();
  const grace = await context.newPage();
  const errors: string[] = [];
  for (const p of [ada, grace]) p.on('pageerror', (e) => errors.push(e.message));

  await openTab(ada, 'ada', tokenAda);
  await openTab(grace, 'grace', tokenGrace);

  const surfaceOf = (p: Page) => p.locator('doc-editor .de-editing-surface');

  // 1. Ada types at the end of the document; Grace sees it.
  await surfaceOf(ada).click();
  await ada.keyboard.press('Control+End');
  await ada.keyboard.type('Alpha ');
  await expect.poll(() => bodyText(grace), { timeout: 20_000 }).toContain('Alpha');

  // 2. Grace types after it; Ada sees that too.
  await surfaceOf(grace).click();
  await grace.keyboard.press('Control+End');
  await grace.keyboard.type('Beta');
  await expect.poll(() => bodyText(ada), { timeout: 20_000 }).toContain('Beta');

  // 3. Ada undoes her own typing: Alpha goes, Grace's Beta stays, in both tabs.
  await surfaceOf(ada).click();
  await ada.keyboard.press('Control+z');
  await expect.poll(() => bodyText(ada), { timeout: 20_000 }).not.toContain('Alpha');
  await expect.poll(() => bodyText(grace), { timeout: 20_000 }).not.toContain('Alpha');
  await expect.poll(() => bodyText(ada), { timeout: 20_000 }).toContain('Beta');

  // 4. Grace selects the word she typed (Shift+Left over four characters) and edits it.
  await surfaceOf(grace).click();
  await grace.keyboard.press('Control+End');
  for (let i = 0; i < 4; i++) await grace.keyboard.press('Shift+ArrowLeft');
  await grace.keyboard.type('Gamma');
  await expect.poll(() => bodyText(ada), { timeout: 20_000 }).toContain('Gamma');
  await expect.poll(() => bodyText(ada), { timeout: 20_000 }).not.toContain('Beta');

  expect(errors).toEqual([]);
  await context.close();
});
