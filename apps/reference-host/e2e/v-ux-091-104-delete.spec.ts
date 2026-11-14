/**
 * Deleting a document from the host's list is soft: the host's catalogue keeps the row with its
 * deletion time, and the service refuses the document (UX-094 criterion 3). Lane V-UX-091-104.
 *
 * Run against a stack that is already up on the lane's ports (see v-ux-091-104-catalogue.spec.ts):
 *
 *   $env:DOCEDIT_DEMO_REUSE = '1'; $env:DOCEDIT_DEMO_HOST_PORT = '57313'
 *   pnpm exec playwright test -c apps/reference-host/playwright.config.ts e2e/v-ux-091-104-delete.spec.ts
 *
 * The test creates its own document, with a title that carries the lane's name, and deletes only
 * that document.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { dataDir } from '../scripts/lib/stack.ts';
import { PEOPLE, recordEvents, serviceUrl } from './support.ts';

const RUN = Date.now().toString(36);

interface CatalogueFile {
  documents: { id: string; deletedAt?: string | null }[];
}

test('a delete in the list is soft: the catalogue keeps the row with its deletion time, and the service refuses the document (UX-094 criterion 3)', async ({
  browser,
}) => {
  const context = await browser.newContext();
  await recordEvents(context);
  const page = await context.newPage();
  try {
    await page.goto('/');
    await page.getByRole('button', { name: `Continue as ${PEOPLE.olivia.name}` }).click();
    await expect(page.getByTestId('acting-as')).toHaveText(PEOPLE.olivia.name);

    const title = `V-UX-091-104 delete ${RUN}`;
    await page.getByLabel('Title', { exact: true }).fill(title);
    await page.getByRole('button', { name: 'Create and open' }).click();
    await expect(page).toHaveURL(/\/docs\/[0-9a-f-]{36}$/);
    const docId = page.url().split('/').pop()!;

    await page.goto(`/as/${PEOPLE.olivia.sub}/`);
    const row = page.locator(`tr[data-document="${docId}"]`);
    await expect(row.getByRole('link')).toHaveText(title);
    await row.getByRole('button', { name: `Delete ${title}` }).click();
    await expect(page.locator(`tr[data-document="${docId}"]`)).toHaveCount(0);

    // Soft in the host: the row stays in the catalogue with its deletion time.
    const catalogue = JSON.parse(
      readFileSync(join(dataDir(), 'catalogue.json'), 'utf8'),
    ) as CatalogueFile;
    const entry = catalogue.documents.find((d) => d.id === docId);
    expect(entry, 'catalogue row kept').toBeDefined();
    expect(entry?.deletedAt).toEqual(expect.any(String));

    // Soft in the service: the document is no longer served to the host.
    const secrets = JSON.parse(readFileSync(join(dataDir(), 'secrets.json'), 'utf8')) as {
      apiKey: { credential: string };
    };
    const r = await fetch(`${serviceUrl()}/v1/documents/${docId}`, {
      headers: { Authorization: `Bearer ${secrets.apiKey.credential}` },
    });
    expect(r.status).toBe(404);
  } finally {
    await context.close();
  }
});
