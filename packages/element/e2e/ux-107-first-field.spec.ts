/**
 * UX-107 criterion 6, against the mock backend (lane w3, 2026-11-27): in a document that does not
 * require `fields`, the author inserts the first form field from the built-in command, in
 * `<doc-editor>` in a real browser, and the mock service (which runs the real room of
 * @docedit/authority with `requiresGrowth`) stores the field and the grown `requires`. The same
 * steps against the document service are `apps/reference-host/e2e/w3-ux-107-first-field.spec.ts`.
 *
 * Run with
 * `DOCEDIT_DEMO_PORT=57365 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/ux-107-first-field.spec.ts --project=<browser>`.
 */
import { expect, test } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const EDITOR = 'doc-editor[data-test="ux107"]';

test('the first form field turns forms on in a document that does not use them (UX-107 criterion 6)', async ({
  page,
}) => {
  await openEmbed(page);
  await mountEditor(page, { sub: 'ada', role: 'editor', name: 'ux107', announce: ['fields'] });
  const stored = () =>
    page.evaluate(() => {
      const e = (
        window as unknown as {
          __embed: {
            docId: string;
            service: {
              document(id: string): {
                content(): { requires: string[]; doc: { type: string; content?: unknown[] } };
              };
            };
          };
        }
      ).__embed;
      const c = e.service.document(e.docId).content();
      let fields = 0;
      const walk = (n: { type?: string; content?: unknown[] }): void => {
        if (n.type === 'form_field') fields++;
        for (const k of n.content ?? []) walk(k as never);
      };
      walk(c.doc);
      return { requires: [...c.requires], fields };
    });
  expect(await stored()).toEqual({ requires: [], fields: 0 });

  await page.locator(`${EDITOR} .de-editing-surface p`).first().click();
  await page.keyboard.press('End');
  const insert = page.locator(
    `${EDITOR} button[data-command-id="insert.field.text"]:not([data-menu-item])`,
  );
  await expect(insert).toBeVisible();
  await expect(insert).not.toHaveAttribute('aria-disabled', 'true');
  await insert.click();
  await expect.poll(stored, { timeout: 20_000 }).toEqual({ requires: ['fields'], fields: 1 });
});
