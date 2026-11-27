/**
 * UX-107 criterion 6 against the demo stack (lane w3, 2026-11-27): in a document that does not
 * require `fields`, the author inserts the first form field from the built-in command, in the
 * published `<doc-editor>` bundle in a real browser, and the document service (PostgreSQL in a
 * Podman container) stores the field and the grown `requires`. The same steps against the mock
 * backend are the engine's test `packages/engine/test/ux-107-fields-growth.test.ts`, which runs the
 * real room of @docedit/authority.
 *
 *   $env:DOCEDIT_DEMO_REUSE = '1'
 *   pnpm exec playwright test -c apps/reference-host/playwright.config.ts e2e/w3-ux-107-first-field.spec.ts
 */
import { expect, test } from '@playwright/test';
import {
  editor,
  eventsOf,
  hostToken,
  PEOPLE,
  recordEvents,
  serviceUrl,
  signIn,
} from './support.ts';

test('the first form field turns forms on in a document that does not use them (UX-107 criterion 6)', async ({
  browser,
}) => {
  const context = await browser.newContext();
  await recordEvents(context);
  const page = await context.newPage();
  try {
    await signIn(page, PEOPLE.olivia);
    await page.getByLabel('Title', { exact: true }).fill(`First field ${Date.now().toString(36)}`);
    await page.getByRole('button', { name: 'Create and open' }).click();
    await expect(page).toHaveURL(/\/docs\/[0-9a-f-]{36}$/);
    const doc = /\/docs\/([0-9a-f-]{36})$/.exec(page.url())![1]!;
    await expect
      .poll(async () => (await eventsOf(page, 'de-ready')).length, { timeout: 60_000 })
      .toBeGreaterThan(0);

    const read = async (): Promise<{ requires: string[]; fields: number }> => {
      const { token } = await hostToken(context, PEOPLE.olivia, doc);
      const r = await context.request.get(`${serviceUrl()}/v1/documents/${doc}/content`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(r.status()).toBe(200);
      const body = (await r.json()) as { requires: string[]; doc: unknown };
      let fields = 0;
      const walk = (n: { type?: string; content?: unknown[] }): void => {
        if (n.type === 'form_field') fields++;
        for (const c of n.content ?? []) walk(c as never);
      };
      walk(body.doc as never);
      return { requires: body.requires, fields };
    };

    expect(await read()).toEqual({ requires: [], fields: 0 });

    // The insert is offered although the document does not require `fields`.
    const insert = editor(page).locator(
      'button[data-command-id="insert.field.text"]:not([data-menu-item])',
    );
    await editor(page).locator('p.de-p').first().click();
    await page.keyboard.press('End');
    await expect(insert).toBeVisible();
    await expect(insert).not.toHaveAttribute('aria-disabled', 'true');
    await insert.click();
    await expect
      .poll(async () => await read(), { timeout: 30_000 })
      .toMatchObject({ requires: ['fields'], fields: 1 });
    // A later read, as a reload sees it.
    await page.reload();
    await expect
      .poll(async () => (await eventsOf(page, 'de-ready')).length, { timeout: 60_000 })
      .toBeGreaterThan(0);
    expect(await read()).toMatchObject({ requires: ['fields'], fields: 1 });
  } finally {
    await context.close();
  }
});
