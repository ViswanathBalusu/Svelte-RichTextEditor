/**
 * Reusing a stopped workflow's document, in the browser (FRW-033 criterion 5): when a workflow was
 * declined or voided, the owner is offered "Copy to a new document" in the lock banner; choosing it
 * hands the host the `seq` the document was sent at and nothing else (the component raises
 * `de-fork-request`; the host calls the fork with its service credential, so the shell never does).
 * Without a host that handles the request, without `manage`, and while the workflow still runs, the
 * command is not offered. The workflow is a stand-in service (harness/frw-028-send-port.ts). Run from
 * the repository root with
 * `DOCEDIT_UI_PORT=57633 pnpm exec playwright test -c packages/ui/playwright.config.ts packages/ui/e2e/frw-033-reuse.spec.ts`.
 */
import type { Page } from '@playwright/test';
import { axe, expect, open, test } from './helpers.ts';

const BANNER = '[data-workflow-lock]';
const REUSE = `${BANNER} [data-workflow-reuse]`;
const OWNER = { rev: 1, docRole: 'owner', caps: ['view', 'comment', 'edit', 'manage'], scopes: {} };
const EDITOR = { rev: 1, docRole: 'editor', caps: ['view', 'comment', 'edit'], scopes: {} };

const forkRequests = (page: Page): Promise<number[]> =>
  page.evaluate(() =>
    (window as unknown as { harness: { forkRequests: number[] } }).harness.forkRequests.slice(),
  );

test.describe('reuse a declined or voided document (FRW-033 criterion 5)', () => {
  for (const send of ['declined', 'voided'] as const) {
    test(`offers a copy of the sent document when the workflow was ${send}`, async ({ page }) => {
      await open(page, { send, permissions: OWNER, extended: true, fork: true });
      const button = page.locator(REUSE);
      await expect(button).toBeVisible();
      await expect(button).toHaveText('Copy to a new document');
      expect(await forkRequests(page)).toEqual([]);
      await button.click();
      // The harness's workflow was sent at commit 7: the host gets that and nothing else.
      expect(await forkRequests(page)).toEqual([7]);
      await expect(
        page
          .locator('[role="status"]', { hasText: 'Asked to copy the document as it was sent' })
          .first(),
      ).toBeAttached();
      expect(await axe(page)).toEqual([]);
    });
  }

  test('is not offered without a host that handles the request, without manage, or while the workflow runs', async ({
    page,
  }) => {
    await open(page, { send: 'declined', permissions: OWNER, extended: true });
    await expect(page.locator(BANNER)).toBeVisible();
    await expect(page.locator(REUSE)).toHaveCount(0);
    await page.goto('about:blank');

    await open(page, { send: 'declined', permissions: EDITOR, extended: true, fork: true });
    await expect(page.locator(BANNER)).toBeVisible();
    await expect(page.locator(REUSE)).toHaveCount(0);
    await page.goto('about:blank');

    await open(page, { send: 'running', permissions: OWNER, extended: true, fork: true });
    await expect(page.locator(BANNER)).toBeVisible();
    await expect(page.locator(REUSE)).toHaveCount(0);
  });
});
