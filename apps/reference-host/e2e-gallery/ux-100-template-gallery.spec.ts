/**
 * The template gallery in a browser (UX-100 criterion 4): axe on the gallery with the WCAG 2.2 AA
 * tags, and a pass with the keyboard alone from the start page to a new document. The page is the
 * host's own SvelteKit app, served by Vite's dev server on an ephemeral port, in front of the real
 * document service in memory (test/support.ts). The accessible names that a screen reader reads
 * (roles, labels, the group of each template) are checked through the accessibility tree; no screen
 * reader program was run. Run from the repository root:
 *
 *   pnpm exec playwright test -c apps/reference-host/playwright.gallery.config.ts
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { Catalogue } from '../src/lib/server/catalogue.ts';
import { registerSeedTemplates } from '../src/lib/server/documents.ts';
import { startHarness, type Harness } from '../test/support.ts';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const APP = fileURLToPath(new URL('..', import.meta.url));

let harness: Harness;
let vite: ViteDevServer;
let base = '';
let person = '';

test.beforeAll(async () => {
  test.setTimeout(180_000);
  harness = await startHarness();
  await registerSeedTemplates(harness.host, harness.host.seed);
  person = harness.host.directory.user('u-olivia')!.name;
  // The host's pages read their settings from the environment, as under the stack.
  const c = harness.host.config;
  Object.assign(process.env, {
    DOCEDIT_HOST_ENDPOINT: c.endpoint,
    DOCEDIT_HOST_REST: c.rest,
    DOCEDIT_SERVICE_ID: c.serviceId,
    DOCEDIT_HOST_TENANT: c.tenant,
    DOCEDIT_HOST_API_KEY: c.apiKey,
    DOCEDIT_HOST_TOKENS: 'service-minted',
    DOCEDIT_HOST_DATA: c.dataDir,
  });
  vite = await createServer({
    root: APP,
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  });
  await vite.listen();
  const address = vite.httpServer!.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await vite?.close();
  await harness?.close();
});

async function signIn(page: Page): Promise<void> {
  await page.goto(`${base}/`);
  await page.getByRole('button', { name: `Continue as ${person}` }).click();
  await expect(page.getByTestId('acting-as')).toHaveText(person);
}

test('the gallery lists the catalogue templates, passes axe, and exposes names and groups', async ({
  page,
}) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Templates' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Templates' })).toBeVisible();
  // Criterion 1: the template of the host's catalogue is listed.
  const group = page.getByRole('form', { name: 'Lease agreement' });
  await expect(group).toBeVisible();
  // Criterion 3: only the kinds that may be prefilled have an input.
  await expect(group.getByLabel('Tenant name')).toBeVisible();
  await expect(group.getByLabel('Monthly rent')).toBeVisible();
  await expect(group.getByLabel('Start date')).toBeVisible();
  await expect(group.getByLabel('Tenant signature')).toHaveCount(0);
  await expect(group.getByLabel('Date signed')).toHaveCount(0);
  await expect(group.getByRole('button', { name: 'Create from Lease agreement' })).toBeVisible();
  // Criterion 4: axe reports no violation.
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
});

test('from the start page to a new document with the keyboard alone', async ({ page }) => {
  await signIn(page);
  const title = `Lease for Flat 9 ${Date.now().toString(36)}`;

  /** Presses Tab until the element matching `name` has focus; fails after `limit` presses. */
  async function tabTo(accessibleName: RegExp | string, limit = 30): Promise<void> {
    for (let i = 0; i < limit; i++) {
      await page.keyboard.press('Tab');
      const focused = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el) return '';
        const label = el.id ? document.querySelector(`label[for="${el.id}"]`)?.textContent : null;
        return (el.getAttribute('aria-label') ?? label ?? el.textContent ?? '').trim();
      });
      if (
        typeof accessibleName === 'string'
          ? focused === accessibleName
          : accessibleName.test(focused)
      )
        return;
    }
    throw new Error(`Tab never reached ${String(accessibleName)}`);
  }

  // The document list has the link to the gallery in the session navigation.
  await tabTo('Templates');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Templates' })).toBeVisible();
  // Reach the form's controls in order, fill them in, and send the form.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await tabTo('Title of the new document');
  await page.keyboard.type(title);
  await tabTo('Tenant name');
  await page.keyboard.type('Ada Lovelace');
  await tabTo('Monthly rent');
  await page.keyboard.type('1200.50');
  await tabTo('Start date');
  await page.keyboard.type('01012027');
  await tabTo('Create from Lease agreement');
  await page.keyboard.press('Enter');
  // The new document opens, and it is in the person's document list with the values prefilled.
  await page.waitForURL(/\/docs\//);
  // The page's own host wrote the catalogue file; this reads it back.
  const catalogue = await Catalogue.open(`${harness.host.config.dataDir}/catalogue.json`);
  const entry = catalogue.listFor('u-olivia').find((d) => d.title === title);
  expect(entry, 'the new document is in the catalogue').toBeDefined();
  const res = await fetch(`${harness.rest}/documents/${entry!.id}/field-values`, {
    headers: { Authorization: `Bearer ${harness.apiKey}` },
  });
  const values = ((await res.json()) as { values: Record<string, unknown> }).values;
  expect(values).toMatchObject({ 'tenant.name': 'Ada Lovelace', 'lease.rent': '1200.50' });
  await page.goto(`${base}/as/u-olivia`);
  await expect(page.getByRole('link', { name: title })).toBeVisible();
});
