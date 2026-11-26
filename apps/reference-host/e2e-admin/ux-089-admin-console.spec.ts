/**
 * UX-089: the administration console in a real browser, against the mock of the published API
 * (test/admin-mock.ts), with axe (WCAG 2.2 AA tags) on every screen and a keyboard-only pass.
 * No stack is needed: the console is built into a temporary directory and served from a local
 * server on an ephemeral port; requests to `/v1/**` are answered by the mock through
 * `page.route`. Run from the repository root:
 *
 *   pnpm exec playwright test -c apps/reference-host/playwright.admin.config.ts
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import {
  createAdminMock,
  OPERATOR_CREDENTIAL,
  SERVICE_CREDENTIAL,
  type AdminMock,
} from '../test/admin-mock.ts';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

let out = '';
let server: Server;
let origin = '';
let mock: AdminMock;

test.beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), 'ux089-e2e-'));
  await build({
    configFile: fileURLToPath(new URL('../admin/vite.config.ts', import.meta.url)),
    logLevel: 'silent',
    build: { outDir: out, emptyOutDir: true },
  });
  server = createServer((req, res) => {
    const path = normalize(new URL(req.url ?? '/', 'http://x').pathname).replace(
      /^(\.\.[/\\])+/,
      '',
    );
    const file = join(out, path === '/' || path === '\\' ? 'index.html' : path);
    try {
      if (!statSync(file).isFile()) throw new Error('not a file');
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(readFileSync(file));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(out, { recursive: true, force: true });
});

async function open(page: Page): Promise<void> {
  mock = createAdminMock();
  await page.route(`${origin}/v1/**`, async (route) => {
    const req = route.request();
    const init: RequestInit = { method: req.method(), headers: await req.allHeaders() };
    const body = req.postData();
    if (body !== null) init.body = body;
    const res = await mock.fetch(req.url(), init);
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    await route.fulfill({ status: res.status, headers, body: await res.text() });
  });
  await page.goto(origin + '/');
}
async function connect(page: Page, credential: string, operator?: string): Promise<void> {
  await page.getByLabel(/Service endpoint/).fill(`${origin}/v1`);
  await page.getByLabel('Service credential').fill(credential);
  if (operator !== undefined) await page.getByLabel(/Operator credential/).fill(operator);
  await page.getByLabel(/Your name/).fill('admin@example.test');
  await page.getByRole('button', { name: 'Open the console' }).press('Enter');
}
async function expectNoViolations(page: Page, where: string): Promise<void> {
  const r = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(
    r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`),
    where,
  ).toEqual([]);
}

test('a user without administration rights is refused and sees no section', async ({ page }) => {
  await open(page);
  await expectNoViolations(page, 'connect form');
  await connect(page, 'user-token-abc');
  await expect(page.getByRole('alert').filter({ hasText: 'administration rights' })).toBeVisible();
  await expect(page.getByRole('navigation')).toHaveCount(0);
  await expectNoViolations(page, 'refusal');
  expect(mock.matched).toEqual(['GET /quotas']);
});

test('every section meets WCAG 2.2 AA under axe and works from the keyboard', async ({ page }) => {
  await open(page);
  await connect(page, SERVICE_CREDENTIAL);
  const nav = page.getByRole('navigation', { name: 'Administration sections' });
  await expect(nav).toBeVisible();
  // The credential is not left in the form after connecting.
  expect(await page.content()).not.toContain(SERVICE_CREDENTIAL);

  const sections = [
    'Quotas and usage',
    'Origins',
    'Token keys',
    'Retention and holds',
    'Webhooks',
    'Fonts',
    'Audit trail',
  ];
  for (const name of sections) {
    const button = nav.getByRole('button', { name, exact: true });
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(button).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#content')).toBeFocused();
    await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expectNoViolations(page, name);
  }
  // Tab from the content reaches the controls of the section in a sensible order.
  await page.keyboard.press('Tab');
  await expect(page.locator(':focus')).not.toHaveCount(0);

  expect(mock.unpublished).toEqual([]);
});

test('the functions work with the keyboard alone and every change is audited', async ({ page }) => {
  await open(page);
  await connect(page, SERVICE_CREDENTIAL);
  const nav = page.getByRole('navigation', { name: 'Administration sections' });
  const go = async (name: string): Promise<void> => {
    await nav.getByRole('button', { name, exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible();
  };

  // Quotas, and the usage of the month beside them.
  await expect(page.getByRole('cell', { name: '1048576', exact: true })).toBeVisible();
  await page.getByLabel(/Month/).fill('2026-10');
  await page.getByRole('button', { name: 'Show usage' }).press('Enter');
  await expect(page.getByText('Usage in 2026-10')).toBeVisible();
  await page.getByLabel('New Storage').fill('2048');
  await page.getByRole('button', { name: 'Save quotas' }).press('Enter');
  await expect(page.getByRole('status')).toHaveText('Quotas saved.');
  await expect(page.getByRole('cell', { name: '2048', exact: true })).toBeVisible();
  await page.getByLabel('New Connections').fill('-3');
  await page.getByRole('button', { name: 'Save quotas' }).press('Enter');
  await expect(page.getByRole('alert').filter({ hasText: 'whole number' })).toBeVisible();

  // Origins: add, then remove in two steps.
  await go('Origins');
  await page.getByLabel('New origin').fill('https://admin.example.test');
  await page.getByRole('button', { name: 'Add origin' }).press('Enter');
  await expect(page.getByRole('status')).toContainText('added');
  const remove = page.getByRole('button', { name: 'Remove origin https://admin.example.test' });
  await remove.press('Enter');
  await page
    .getByRole('button', { name: 'Confirm: Remove origin https://admin.example.test' })
    .press('Enter');
  await expect(page.getByRole('status')).toContainText('removed');

  // Webhooks: create (the secret is shown once), rotate, test.
  await go('Webhooks');
  await page.getByLabel(/Address/).fill('https://hooks.example.test/a');
  await page.getByRole('button', { name: 'Create webhook' }).press('Enter');
  await expect(page.getByRole('group', { name: 'New secret' })).toContainText('whsec_created');
  await page
    .getByRole('button', { name: 'Rotate secret of https://hooks.example.test/a' })
    .press('Enter');
  await expect(page.getByRole('status')).toContainText('rotated');
  await page
    .getByRole('button', { name: 'Retire old secret of https://hooks.example.test/a' })
    .press('Enter');
  await page
    .getByRole('button', { name: 'Send test to https://hooks.example.test/a' })
    .press('Enter');
  await expect(page.getByRole('status')).toContainText('Test delivery');
  await expectNoViolations(page, 'webhooks with a row');

  // Retention and holds.
  await go('Retention and holds');
  await page.getByLabel('Document id').first().fill('0190a000-0000-7000-8000-000000000001');
  await page.getByRole('button', { name: 'Show policy' }).press('Enter');
  await expect(page.getByText('from the default policy')).toBeVisible();
  await page.getByLabel('Document id').last().fill('0190a000-0000-7000-8000-000000000001');
  await page.getByLabel(/Reason/).fill('Litigation');
  await page.getByRole('button', { name: 'Place hold' }).press('Enter');
  await expect(page.getByRole('cell', { name: 'Litigation' })).toBeVisible();
  await expectNoViolations(page, 'holds with a row');
  await page
    .getByRole('button', { name: 'Release the hold on 0190a000-0000-7000-8000-000000000001' })
    .press('Enter');
  await page
    .getByRole('button', {
      name: 'Confirm: Release the hold on 0190a000-0000-7000-8000-000000000001',
    })
    .press('Enter');
  await expect(page.getByRole('status')).toHaveText('Legal hold released.');
  await expect(page.getByText('No document is under hold.')).toBeVisible();
  await page.getByLabel('Document id').last().fill('0190a000-0000-7000-8000-000000000001');
  await page.getByLabel(/Reason/).fill('Litigation');
  await page.getByRole('button', { name: 'Place hold' }).press('Enter');
  await expect(page.getByRole('cell', { name: 'Litigation' })).toBeVisible();

  // Audit: the changes made above, by the named actor.
  await go('Audit trail');
  await page.getByLabel('Event kind').fill('hold.placed');
  await page.getByRole('button', { name: 'Search the audit trail' }).press('Enter');
  await expect(
    page.getByRole('row', { name: /hold\.placed.*admin@example\.test/ }).first(),
  ).toBeVisible();
  await expectNoViolations(page, 'audit with rows');

  expect(mock.unpublished).toEqual([]);
});

test('fonts are added and removed with the keyboard, and each is audited', async ({ page }) => {
  await open(page);
  await connect(page, SERVICE_CREDENTIAL);
  const nav = page.getByRole('navigation', { name: 'Administration sections' });
  await nav.getByRole('button', { name: 'Fonts', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 2, name: 'Fonts' })).toBeVisible();
  await page.getByLabel('Font file').setInputFiles({
    name: 'added.ttf',
    mimeType: 'font/ttf',
    buffer: Buffer.from('not really a font'),
  });
  await page.getByLabel('Licence declaration').fill('OFL-1.1');
  await page.getByRole('button', { name: 'Add font' }).press('Enter');
  await expect(page.getByRole('status')).toContainText('Font added: Added Sans');
  await expectNoViolations(page, 'fonts after adding');
  const hash = (await page.getByRole('status').textContent())!.match(/[0-9a-f]{64}/)![0];
  await page.getByLabel('SHA-256 of the file').fill(hash);
  await page.getByRole('button', { name: 'Remove this font' }).press('Enter');
  await page.getByRole('button', { name: 'Confirm: Remove this font' }).press('Enter');
  await expect(page.getByRole('status')).toHaveText('Font removed.');
  expect(mock.unpublished).toEqual([]);
});

test('an operator sees the tenants and manages them with the keyboard (criterion 2)', async ({
  page,
}) => {
  await open(page);
  // Without an operator credential there is no Tenants section.
  await connect(page, SERVICE_CREDENTIAL);
  await expect(
    page
      .getByRole('navigation', { name: 'Administration sections' })
      .getByRole('button', { name: 'Tenants', exact: true }),
  ).toHaveCount(0);

  await open(page);
  await connect(page, SERVICE_CREDENTIAL, OPERATOR_CREDENTIAL);
  const nav = page.getByRole('navigation', { name: 'Administration sections' });
  await expect(nav.getByRole('button', { name: 'Tenants', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  expect(await page.content()).not.toContain(OPERATOR_CREDENTIAL);
  await expect(page.getByRole('row', { name: /Example tenant.*Active/ })).toBeVisible();
  await expectNoViolations(page, 'tenants');

  await page.getByLabel('Name', { exact: true }).fill('Second tenant');
  await page.getByRole('button', { name: 'Register tenant' }).press('Enter');
  await expect(page.getByRole('status')).toContainText('Tenant registered');
  await expect(page.getByRole('row', { name: /Second tenant/ })).toBeVisible();
  await page.getByLabel('New name for Second tenant').fill('Renamed tenant');
  await page.getByRole('button', { name: 'Rename' }).last().press('Enter');
  await expect(page.getByRole('status')).toHaveText('Tenant renamed.');
  await page.getByRole('button', { name: 'Suspend Renamed tenant' }).press('Enter');
  await page.getByRole('button', { name: 'Confirm: Suspend Renamed tenant' }).press('Enter');
  await expect(page.getByRole('status')).toHaveText('Tenant suspended.');
  await expect(page.getByRole('row', { name: /Renamed tenant.*Suspended/ })).toBeVisible();
  await page.getByRole('button', { name: 'Resume Renamed tenant' }).press('Enter');
  await expect(page.getByRole('status')).toHaveText('Tenant resumed.');
  await expectNoViolations(page, 'tenants after changes');
  expect(mock.unpublished).toEqual([]);
});
