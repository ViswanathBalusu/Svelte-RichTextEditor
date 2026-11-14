/**
 * The demo stack as a whole, and what the browser can see of it (UX-091 criteria 1 and 3; UX-092
 * criterion 3). Lane U-UX-091-104, round 6.
 *
 * Run against a stack that is already up on the lane's ports (scripts/stack.ps1 up with
 * DOCEDIT_DEMO_PROJECT=docedit-u-ux-091-104-demo, DOCEDIT_DEMO_PG_PORT=56310,
 * DOCEDIT_DEMO_S3_PORT=56311, DOCEDIT_DEMO_SERVICE_PORT=56312, DOCEDIT_DEMO_HOST_PORT=56313):
 *
 *   $env:DOCEDIT_DEMO_REUSE = '1'
 *   pnpm exec playwright test -c apps/reference-host/playwright.config.ts e2e/u-ux-091-104-stack.spec.ts
 *
 * The test creates one document with a title that carries the lane's name and changes nothing else.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { dataDir } from '../scripts/lib/stack.ts';
import {
  hostUrl,
  openDocument,
  PEOPLE,
  recordEvents,
  serviceUrl,
  workerStatus,
} from './support.ts';

const RUN = Date.now().toString(36);
const SEEDED_TITLE = 'Supply agreement (demo)';
const TOKEN = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

/** Every string of at least `min` characters inside a JSON value. */
function strings(value: unknown, min: number, out: string[] = []): string[] {
  if (typeof value === 'string') {
    if (value.length >= min) out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) strings(v, min, out);
  } else if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) strings(v, min, out);
  }
  return out;
}

test('the five parts answer, the people and the seeded document are there (UX-091 criterion 1)', async ({
  page,
}) => {
  const ready = await fetch(`${serviceUrl()}/readyz`);
  expect(ready.ok, 'document service /readyz').toBe(true);
  const dep = await fetch(`${serviceUrl()}/.well-known/dep`);
  expect(dep.ok, 'document service discovery').toBe(true);
  const healthy = await fetch(`${hostUrl()}/healthz`);
  expect(healthy.ok, 'reference host /healthz').toBe(true);
  expect(workerStatus().running, 'export worker').toBe(true);

  const catalogue = readFileSync(join(dataDir(), 'catalogue.json'), 'utf8');
  expect(catalogue).toContain(SEEDED_TITLE);

  await page.goto('/');
  for (const person of Object.values(PEOPLE))
    await expect(page.getByRole('button', { name: `Continue as ${person.name}` })).toBeVisible();
});

test('the private key and the service credential never reach the browser; the token is in no URL, storage or log (UX-092 criterion 3)', async ({
  browser,
}) => {
  const secrets = JSON.parse(readFileSync(join(dataDir(), 'secrets.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  // Private parts: every string of the signing keys (their `d`, `p`, `q`, ...), the service
  // credential, and the keys the stack keeps for itself.
  const secretValues = [
    ...strings(secrets['hostSigning'], 16),
    ...strings(secrets['serviceSigning'], 16),
    ...strings(secrets['apiKey'], 16),
    ...strings(secrets['viewKey'], 12),
    ...strings(secrets['cursorSecret'], 12),
  ];
  expect(secretValues.length).toBeGreaterThan(0);

  const context = await browser.newContext();
  await recordEvents(context);
  const page = await context.newPage();
  const urls: string[] = [];
  const bodies: string[] = [];
  page.on('request', (r) => urls.push(r.url()));
  page.on('response', async (r) => {
    try {
      bodies.push(await r.text());
    } catch {
      // Redirects and bodies the browser does not keep have no text; nothing to check there.
    }
  });

  try {
    await page.goto('/');
    await page.getByRole('button', { name: `Continue as ${PEOPLE.olivia.name}` }).click();
    await page.getByLabel('Title', { exact: true }).fill(`U-UX-091-104 token ${RUN}`);
    await page.getByRole('button', { name: 'Create and open' }).click();
    await expect(page).toHaveURL(/\/docs\/[0-9a-f-]{36}$/);
    const docId = page.url().split('/').pop()!;
    await openDocument(page, PEOPLE.olivia, docId);
    await page.waitForTimeout(500);

    const storage = await page.evaluate(() => ({
      local: JSON.stringify({ ...localStorage }),
      session: JSON.stringify({ ...sessionStorage }),
    }));
    const tokens = new Set(bodies.flatMap((b) => b.match(TOKEN) ?? []));
    expect(tokens.size, 'a token reached the page (the test is not vacuous)').toBeGreaterThan(0);

    for (const token of tokens) {
      expect(
        urls.some((u) => u.includes(token)),
        'token in a URL',
      ).toBe(false);
      expect(storage.local.includes(token), 'token in localStorage').toBe(false);
      expect(storage.session.includes(token), 'token in sessionStorage').toBe(false);
    }
    for (const secret of secretValues) {
      expect(
        urls.some((u) => u.includes(secret)),
        'secret in a URL',
      ).toBe(false);
      expect(
        bodies.some((b) => b.includes(secret)),
        'secret in a response the browser received',
      ).toBe(false);
      expect(storage.local.includes(secret), 'secret in localStorage').toBe(false);
      expect(storage.session.includes(secret), 'secret in sessionStorage').toBe(false);
    }

    // The host's log holds no token and no secret either.
    const logDir = join(dataDir(), 'logs');
    for (const file of readdirSync(logDir)) {
      const text = readFileSync(join(logDir, file), 'utf8');
      for (const token of tokens) expect(text.includes(token), `token in ${file}`).toBe(false);
      for (const secret of secretValues)
        expect(text.includes(secret), `secret in ${file}`).toBe(false);
    }
  } finally {
    await context.close();
  }
});
