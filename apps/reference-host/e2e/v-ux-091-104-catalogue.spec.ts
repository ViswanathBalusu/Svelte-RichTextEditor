/**
 * The document list and the host's catalogue in a browser against the demo stack (UX-094 criteria
 * 2, 3 and 5). Lane V-UX-091-104.
 *
 * Run against a stack that is already up on the lane's ports (scripts/stack.ps1 up with
 * DOCEDIT_DEMO_HOST_PORT=57313 and DOCEDIT_DEMO_SERVICE_PORT=57312):
 *
 *   $env:DOCEDIT_DEMO_REUSE = '1'; $env:DOCEDIT_DEMO_HOST_PORT = '57313'
 *   pnpm exec playwright test -c apps/reference-host/playwright.config.ts e2e/v-ux-091-104-catalogue.spec.ts
 *
 * Every document is created by the test, with a title that carries the lane's name, and only the
 * test's own documents are changed.
 */
import { expect, test, type Page, type Request } from '@playwright/test';
import { openDocument, PEOPLE, recordEvents, serviceUrl } from './support.ts';

const RUN = Date.now().toString(36);

async function signInAsOlivia(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: `Continue as ${PEOPLE.olivia.name}` }).click();
  await expect(page.getByTestId('acting-as')).toHaveText(PEOPLE.olivia.name);
}

test('a new document opens with its title in the title slot; a rename reaches the list and the slot; the editor never calls the listing (UX-094 criteria 2, 3, 5)', async ({
  browser,
}) => {
  const context = await browser.newContext();
  await recordEvents(context);
  const page = await context.newPage();
  const requests: Request[] = [];
  page.on('request', (r) => requests.push(r));
  try {
    await signInAsOlivia(page);
    const title = `V-UX-091-104 catalogue ${RUN}`;
    const renamed = `V-UX-091-104 renamed ${RUN}`;

    // Criterion 2: "new document" creates it through the host and opens it with the title.
    await page.getByLabel('Title', { exact: true }).fill(title);
    await page.getByRole('button', { name: 'Create and open' }).click();
    await expect(page).toHaveURL(/\/docs\/[0-9a-f-]{36}$/);
    const docId = page.url().split('/').pop()!;
    await openDocument(page, PEOPLE.olivia, docId);
    await expect(page.getByTestId('title-slot')).toHaveText(title);

    // The host stored the external identifier at creation (its list shows it on the row).
    await page.goto(`/as/${PEOPLE.olivia.sub}/`);
    const row = page.locator(`tr[data-document="${docId}"]`);
    await expect(row).toHaveAttribute('data-external-id', /.+/);

    // Criterion 3: a rename in the host changes the catalogue, the list and the title slot.
    await row.getByLabel(`New title for ${title}`).fill(renamed);
    await row.getByRole('button', { name: 'Rename' }).click();
    await expect(page.getByRole('status')).toHaveText('Renamed.');
    await expect(page.locator(`tr[data-document="${docId}"] a`)).toHaveText(renamed);
    await openDocument(page, PEOPLE.olivia, docId);
    await expect(page.getByTestId('title-slot')).toHaveText(renamed);

    // Criterion 5: while the editor runs, the page never calls the document listing or search of
    // the service; it only reads and writes the one document it opened.
    const service = serviceUrl();
    const before = requests.length;
    await openDocument(page, PEOPLE.olivia, docId);
    await expect(page.getByTestId('title-slot')).toHaveText(renamed);
    const editorCalls = requests.slice(before).map((r) => r.url());
    const listing = editorCalls.filter(
      (u) => /\/v1\/documents\/?(\?|$)/.test(u) || /\/v1\/search(\?|$)/.test(u),
    );
    expect(listing).toEqual([]);
    expect(editorCalls.some((u) => u.startsWith(`${service}/v1/documents/${docId}`))).toBe(true);
  } finally {
    await context.close();
  }
});
