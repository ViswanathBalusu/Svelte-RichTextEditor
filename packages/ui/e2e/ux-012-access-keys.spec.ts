/**
 * Access keys (UX-012; 13 §4): Alt pressed and released alone shows the key of each control on the
 * toolbars and gives the controls their key as text for assistive technology. A shown key runs its
 * command; a command the permissions disallow runs nothing and its reason is announced; Escape
 * leaves the mode and returns focus to the text; the host page's own keys do not reach the mode.
 *
 * The built-in commands declare no access key yet (the level and key choice is open, and the
 * registry's property test assumes none on the format level), so these tests register an extension
 * command with the key `k`, in its own group. The gesture itself is proposed (docs/adr/0325-lane-U-
 * UX-001-015.md). Run with `DOCEDIT_UI_PORT=57250 pnpm exec playwright test -c
 * packages/ui/playwright.config.ts packages/ui/e2e/ux-012-access-keys.spec.ts`.
 */
import type { Page } from '@playwright/test';
import { expect, focusSurface, focused, open, test } from './helpers.ts';

const VIEW_ONLY = { scope: 'body', caps: ['view'], limit: 'role' } as const;
const STAMP = 'ext.stamp';

async function tapAlt(page: Page): Promise<void> {
  await page.keyboard.down('Alt');
  await page.keyboard.up('Alt');
}

/** An extension command that changes the text, with the access key `k`, in its own group. */
async function registerStamp(h: Awaited<ReturnType<typeof open>>): Promise<void> {
  const error = await h.tryRegister({
    id: STAMP,
    label: 'command.format.bold',
    group: 'ext.stamp',
    accessKey: 'k',
    changesContent: true,
    enabled: 'canEditSelection',
  });
  expect(error).toBeNull();
}

test.describe('access keys (UX-012)', () => {
  test('Alt alone shows the key, a shown key runs its command, and focus returns to the text', async ({
    page,
  }) => {
    const h = await open(page, { extended: true });
    await registerStamp(h);
    await focusSurface(page);
    await tapAlt(page);
    await expect(page.locator('[data-access-tip="K"]')).toHaveCount(1);
    await expect(page.locator(`[data-command-id="${STAMP}"]`)).toHaveAccessibleDescription(
      'Access key K',
    );
    await page.keyboard.press('k');
    expect(await h.commandRuns()).toEqual([STAMP]);
    await expect(page.locator('[data-access-tip]')).toHaveCount(0);
    await expect(page.locator(`[data-command-id="${STAMP}"]`)).not.toHaveAttribute(
      'aria-description',
      /.+/,
    );
    expect((await focused(page)).className).toContain('de-editing-surface');
  });

  test('Escape leaves the mode, runs nothing and returns focus to the text', async ({ page }) => {
    const h = await open(page, { extended: true });
    await registerStamp(h);
    await focusSurface(page);
    await tapAlt(page);
    await expect(page.locator('[data-access-tip="K"]')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-access-tip]')).toHaveCount(0);
    expect(await h.commandRuns()).toEqual([]);
    expect((await focused(page)).className).toContain('de-editing-surface');
  });

  test('Alt used with a letter is a shortcut, not the gesture', async ({ page }) => {
    const h = await open(page, { extended: true });
    await registerStamp(h);
    await focusSurface(page);
    await page.keyboard.press('Alt+q');
    await expect(page.getByRole('combobox', { name: 'Command name' })).toBeVisible();
    await expect(page.locator('[data-access-tip]')).toHaveCount(0);
  });

  test('a command the permissions disallow runs nothing, and its reason is announced', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, access: VIEW_ONLY });
    await registerStamp(h);
    await focusSurface(page);
    await tapAlt(page);
    await expect(page.locator(`[data-command-id="${STAMP}"]`)).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await page.keyboard.press('k');
    expect(await h.commandRuns()).toEqual([]);
    await expect(page.getByRole('status')).toContainText(
      'You can view this part of the document but not change it.',
    );
    await expect(page.locator('[data-access-tip]')).toHaveCount(0);
  });

  test('a key nothing shows runs nothing and the mode stays until Escape', async ({ page }) => {
    const h = await open(page, { extended: true });
    await registerStamp(h);
    await focusSurface(page);
    await tapAlt(page);
    await page.keyboard.press('z');
    expect(await h.commandRuns()).toEqual([]);
    await expect(page.locator('[data-access-tip="K"]')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-access-tip]')).toHaveCount(0);
  });

  test('the host page does not react to the gesture', async ({ page }) => {
    const h = await open(page, { extended: true });
    await registerStamp(h);
    await page.locator('#after').focus();
    await tapAlt(page);
    await expect(page.locator('[data-access-tip]')).toHaveCount(0);
    await page.keyboard.press('k');
    expect(await h.commandRuns()).toEqual([]);
  });
});
