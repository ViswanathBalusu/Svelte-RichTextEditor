/**
 * The lock a workflow puts on the document, in the browser (FRW-029 criterion 6): a banner says the
 * document is out for completion and who may still act, or that a declined or voided workflow keeps
 * it locked; it follows the workflow's state; and a refused change is explained in the workflow's
 * words instead of being dropped. The state and the people are a stand-in service
 * (harness/frw-028-send-port.ts); the service over the workflow port is tested in packages/element and
 * the rules of the lock in packages/authority. Run from the repository root with
 * `DOCEDIT_UI_PORT=57629 pnpm exec playwright test -c packages/ui/playwright.config.ts packages/ui/e2e/frw-029-lock-banner.spec.ts`.
 */
import { axe, expect, open, test } from './helpers.ts';

const BANNER = '[data-workflow-lock]';
const OWNER = { rev: 1, docRole: 'owner', caps: ['view', 'comment', 'edit', 'manage'], scopes: {} };

test.describe('the lock banner (FRW-029 criterion 6)', () => {
  test('says the document is out for completion and who may act now', async ({ page }) => {
    await open(page, { send: 'running', permissions: OWNER, extended: true });
    const banner = page.locator(BANNER);
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute('data-workflow-lock', 'running');
    await expect(banner).toHaveAttribute('role', 'region');
    await expect(banner).toHaveAccessibleName('Workflow status');
    await expect(banner.locator('[data-banner="state"]')).toContainText('Out for completion');
    await expect(banner.locator('[data-banner="state"]')).toContainText('locked');
    await expect(banner.locator('[data-banner="actors"]')).toHaveText('May act now: Ada Lovelace.');
    // The participant who waits is not named as one who may act now.
    await expect(banner).not.toContainText('role_landlord');
    expect(await axe(page)).toEqual([]);
  });

  test('says a declined or a voided workflow keeps the document locked, with nobody to act', async ({
    page,
  }) => {
    await open(page, { send: 'declined', permissions: OWNER, extended: true });
    const banner = page.locator(BANNER);
    await expect(banner).toHaveAttribute('data-workflow-lock', 'declined');
    await expect(banner).toContainText('The workflow was declined. The document stays locked.');
    await expect(banner.locator('[data-banner="actors"]')).toHaveCount(0);
    await page.goto('about:blank');

    await open(page, { send: 'voided', permissions: OWNER, extended: true });
    await expect(page.locator(BANNER)).toContainText('The workflow was voided.');
  });

  test('is absent for a draft, appears when the workflow is sent and goes when it is a draft again', async ({
    page,
  }) => {
    const h = await open(page, { send: 'pass', permissions: OWNER, extended: true });
    await expect(page.locator(BANNER)).toHaveCount(0);
    await h.setSendState('in_progress');
    await expect(page.locator(BANNER)).toBeVisible();
    await h.setSendState('draft');
    await expect(page.locator(BANNER)).toHaveCount(0);
  });

  test('is not drawn when the backend has no workflow port', async ({ page }) => {
    await open(page, { permissions: OWNER, extended: true });
    await expect(page.locator(BANNER)).toHaveCount(0);
  });

  test('explains a refused change in the workflow words, and says nothing of one when no workflow locks', async ({
    page,
  }) => {
    const h = await open(page, { send: 'running', permissions: OWNER, extended: true });
    await h.refuse('read-only', ['body']);
    const notice = page.locator('.de-notice');
    await expect(notice).toContainText('the document is out for completion and is locked');
    await page.goto('about:blank');

    const open2 = await open(page, { send: 'pass', permissions: OWNER, extended: true });
    await open2.refuse('read-only', ['body']);
    await expect(page.locator('.de-notice')).toContainText('the document is read-only here');
  });
});
