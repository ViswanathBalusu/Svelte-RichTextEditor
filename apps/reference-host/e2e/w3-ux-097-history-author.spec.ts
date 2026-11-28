/**
 * UX-097 criterion 5 against the demo stack (lane w3, 2026-11-27): the host starts a document from
 * a template of the gallery and fills the tenant's name in the same call, with its own service
 * credential and `DEP-Actor` naming the signed-in user (13 §11.3). The history pane of the published
 * `<doc-editor>` bundle, in a real browser, lists that commit under the person's name from the
 * host's directory (not under the service and not as an unknown person).
 *
 *   $env:DOCEDIT_DEMO_REUSE = '1'
 *   pnpm exec playwright test -c apps/reference-host/playwright.config.ts e2e/w3-ux-097-history-author.spec.ts
 */
import { expect, test } from '@playwright/test';
import { editor, eventsOf, PEOPLE, recordEvents, runCommand, signIn } from './support.ts';

test('the history pane shows the signed-in user as the author of a server-side prefill (UX-097 criterion 5)', async ({
  browser,
}) => {
  const context = await browser.newContext();
  await recordEvents(context);
  const page = await context.newPage();
  try {
    await signIn(page, PEOPLE.olivia);
    await page.goto(`/as/${PEOPLE.olivia.sub}/templates`);
    const lease = page.locator('[data-template="lease"]');
    await lease.getByLabel('Title of the new document').fill(`Lease ${Date.now().toString(36)}`);
    await lease.getByLabel('Tenant name').fill('Ines Duarte');
    await lease.getByRole('button', { name: /^Create from / }).click();
    await expect(page).toHaveURL(/\/docs\/[0-9a-f-]{36}$/);
    await expect
      .poll(async () => (await eventsOf(page, 'de-ready')).length, { timeout: 60_000 })
      .toBeGreaterThan(0);

    await runCommand(page, 'view.history');
    const groups = editor(page).locator('[data-history="group"]');
    await expect(groups.first()).toBeVisible({ timeout: 30_000 });
    // The author is named from the host's directory, which the element asked for the identifier.
    await expect(groups.first()).toContainText(PEOPLE.olivia.name);
    await expect(groups.first()).not.toContainText('Unknown person');
    await expect(groups.first()).not.toContainText(/system/i);
  } finally {
    await context.close();
  }
});
