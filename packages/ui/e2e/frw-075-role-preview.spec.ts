/**
 * The preview as a role, in the browser (FRW-075 criterion 4): starting it from the roles pane
 * shows a bar that names the role, the start and the end are announced in the page's status
 * region, and the control that leaves the preview is reached with the keyboard alone. The core is
 * the harness's stand-in; what the core does with the preview (no commit, the caret, the rules) is
 * tested over the real authority in packages/engine/test/frw-075.role-preview.test.ts. Run from the
 * repository root with
 * `DOCEDIT_UI_PORT=56433 pnpm exec playwright test -c packages/ui/playwright.config.ts packages/ui/e2e/frw-075-role-preview.spec.ts`.
 */
import type { Page } from '@playwright/test';
import { axe, expect, focused, open, test } from './helpers.ts';

const OWNER = { rev: 1, docRole: 'owner', caps: ['view', 'comment', 'edit', 'manage'], scopes: {} };

/** The text of the shell's status region, which announcements are written to. */
const status = (page: Page) => page.locator('#host >> .de-visually-hidden[role="status"]');

test.describe('the bar of the preview as a role (FRW-075 criterion 4)', () => {
  test('starts from the roles pane, names the role and announces it', async ({ page }) => {
    const h = await open(page, { rolePreview: true, permissions: OWNER, extended: true });
    await h.openPane('roles');
    const pane = page.locator('.de-pane[data-pane="roles"]');
    const button = pane.getByRole('button', { name: 'Preview as Tenant' });
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    await button.click();
    expect(await h.rolePreviewLog()).toEqual(['start:role_tenant']);

    const bar = page.getByRole('region', { name: 'Preview as a role' });
    await expect(bar).toBeVisible();
    await expect(bar).toContainText('Previewing as Tenant. What you enter here is not saved.');
    await expect(status(page)).toHaveText(
      'Preview as Tenant started. What you enter here is not saved.',
    );
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(await axe(page)).toEqual([]);
  });

  test('is left with the keyboard alone, and the end is announced', async ({ page }) => {
    const h = await open(page, { rolePreview: true, permissions: OWNER, extended: true });
    await h.openPane('roles');
    const pane = page.locator('.de-pane[data-pane="roles"]');
    await pane.getByRole('button', { name: 'Preview as Landlord' }).click();
    const leave = page.getByRole('button', { name: 'Leave preview' });
    await expect(leave).toBeVisible();

    // Tab from the start of the shell until the control has focus: it is in the tab order.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    let reached = false;
    for (let i = 0; i < 40 && !reached; i++) {
      await page.keyboard.press('Tab');
      reached = (await focused(page)).text === 'Leave preview';
    }
    expect(reached).toBe(true);
    await page.keyboard.press('Enter');

    expect(await h.rolePreviewLog()).toEqual(['start:role_landlord', 'end']);
    await expect(page.getByRole('region', { name: 'Preview as a role' })).toHaveCount(0);
    await expect(status(page)).toHaveText('Preview ended. The document is as it was.');
  });

  test('the pane button toggles the same preview off', async ({ page }) => {
    const h = await open(page, { rolePreview: true, permissions: OWNER, extended: true });
    await h.openPane('roles');
    const pane = page.locator('.de-pane[data-pane="roles"]');
    const button = pane.getByRole('button', { name: 'Preview as Tenant' });
    await button.click();
    await button.click();
    expect(await h.rolePreviewLog()).toEqual(['start:role_tenant', 'end']);
    await expect(button).toHaveAttribute('aria-pressed', 'false');
  });
});
