/**
 * The field properties panel alone (FRW-073), in the browser: one control per property, the gate's
 * reasons shown in a live region with nothing committed, a commit of the changed attributes only,
 * the read-only state, and keyboard use. Run with
 * `DOCEDIT_UI_PORT=57433 pnpm exec playwright test -c packages/ui/playwright.config.ts packages/ui/e2e/frw-073-panel.spec.ts`.
 * The core, undo and history of criterion 3 are not in this page: the harness only records commits.
 */
import { expect, test, type Page } from '@playwright/test';

const PROPERTY_LABELS = [
  'Key',
  'Kind',
  'Label',
  'Assignee (role)',
  'Required',
  'Read-only',
  'Default value',
  'Placeholder',
  'Options',
  'Format (JSON object)',
  'Validation (JSON object)',
  'Width (points)',
];

function commits(page: Page): Promise<unknown[]> {
  return page.evaluate(
    () => (window as unknown as { harness: { commits: unknown[] } }).harness.commits,
  );
}

test.describe('FRW-073 properties panel', () => {
  test('offers one control for each of the twelve properties and none for sensitive', async ({
    page,
  }) => {
    await page.goto('/field-properties.html');
    for (const name of PROPERTY_LABELS)
      await expect(page.getByLabel(name, { exact: true })).toBeVisible();
    await expect(page.getByLabel('Sensitive', { exact: false })).toHaveCount(0);
  });

  test('refuses a key another field uses, shows the reason and commits nothing', async ({
    page,
  }) => {
    await page.goto('/field-properties.html?dupKey=1');
    const key = page.getByLabel('Key', { exact: true });
    await key.fill('tenant.name');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByRole('alert')).toContainText('Another field already uses this key.');
    await expect(key).toHaveAttribute('aria-invalid', 'true');
    expect(await commits(page)).toEqual([]);
  });

  test('refuses a validation limit with its reason and a value that is not a JSON object', async ({
    page,
  }) => {
    await page.goto('/field-properties.html');
    const validation = page.getByLabel('Validation (JSON object)', { exact: true });
    await validation.fill('{"min":"9","max":"1"}');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByRole('alert')).toContainText('A validation limit is not valid.');
    await validation.fill('not json');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByRole('alert')).toContainText('This is not a JSON object.');
    expect(await commits(page)).toEqual([]);
  });

  test('commits only the attributes that changed', async ({ page }) => {
    await page.goto('/field-properties.html');
    await page.getByLabel('Label', { exact: true }).fill('Rent');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Applied.' })).toBeVisible();
    expect(await commits(page)).toEqual([{ label: 'Rent' }]);
  });

  test('is read-only without edit: every control is disabled and nothing commits', async ({
    page,
  }) => {
    await page.goto('/field-properties.html?readOnly=1');
    await expect(
      page.getByRole('status').filter({ hasText: 'cannot be changed now' }),
    ).toBeVisible();
    for (const name of PROPERTY_LABELS)
      await expect(page.getByLabel(name, { exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Apply' })).toBeDisabled();
  });

  test('is operable from the keyboard alone, and Enter on Apply commits', async ({ page }) => {
    await page.goto('/field-properties.html');
    const label = page.getByLabel('Label', { exact: true });
    await label.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' (2)');
    // Tab through the remaining controls until Apply has focus.
    for (let i = 0; i < 40; i++) {
      const isApply = await page.evaluate(
        () => document.activeElement?.textContent?.trim() === 'Apply',
      );
      if (isApply) break;
      await page.keyboard.press('Tab');
    }
    await page.keyboard.press('Enter');
    expect(await commits(page)).toEqual([{ label: 'Monthly rent (2)' }]);
  });
});
