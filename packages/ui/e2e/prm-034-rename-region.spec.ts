/**
 * Renaming a region from the permissions pane (PRM-034, criteria 1 and 5; lane w9): a person with
 * `structure` and `edit` in the region types a new name, the pane runs `renameRegion` and shows the
 * new title; a person without them finds the control disabled with the reason in text, and nothing
 * is run. The core here is the shell's fake core, so the engine's own rule is `packages/engine/test`.
 * Run with `pnpm exec playwright test -c packages/ui/playwright.config.ts
 * packages/ui/e2e/prm-034-rename-region.spec.ts --project=chromium` (DOCEDIT_UI_PORT in 56500 to 56509).
 */
import { expect, open, test } from './helpers.ts';

const REGIONS = [
  { id: 'r1', title: 'Terms', policy: 'inherit' as const, order: 0, state: 'draft' as const },
];
const EDITOR = {
  rev: 3,
  docRole: 'editor',
  caps: ['view', 'comment', 'suggest', 'edit', 'structure'],
  scopes: {
    body: ['view', 'comment', 'suggest', 'edit'],
    'region:r1': ['view', 'comment', 'suggest', 'edit'],
  },
};
const SUGGESTER = {
  ...EDITOR,
  docRole: 'suggester',
  caps: ['view', 'comment', 'suggest'],
  scopes: { body: ['view', 'comment', 'suggest'], 'region:r1': ['view', 'comment', 'suggest'] },
};

test.describe('renaming a region from the permissions pane (PRM-034)', () => {
  test('runs the command with the typed name and shows the new title (criterion 1)', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, regions: REGIONS, permissions: EDITOR });
    await h.exec('view.permissions');
    const pane = page.locator('.de-pane[data-pane="permissions"]');
    await pane.locator('[data-region="r1"]').getByRole('button').click();

    const field = pane.getByLabel('Name of the region');
    await expect(field).toHaveValue('Terms');
    await expect(field).toBeEnabled();
    await expect(pane.getByRole('button', { name: 'Rename' })).toBeDisabled();
    await field.fill('Conditions');
    await field.press('Enter');

    expect(await h.named()).toContainEqual(['renameRegion', { region: 'r1', title: 'Conditions' }]);
    await expect(pane.locator('[data-region="r1"]')).toContainText('Conditions');
    await expect(pane.locator('h3[data-content]')).toHaveText('Conditions');
    await expect(field).toHaveValue('Conditions');
  });

  test('is disabled with the reason in text when the person cannot change the structure (criterion 5)', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, regions: REGIONS, permissions: SUGGESTER });
    await h.exec('view.permissions');
    const pane = page.locator('.de-pane[data-pane="permissions"]');
    await pane.locator('[data-region="r1"]').getByRole('button').click();

    const field = pane.getByLabel('Name of the region');
    await expect(field).toBeDisabled();
    await expect(pane.getByRole('button', { name: 'Rename' })).toBeDisabled();
    await expect(field).toHaveAccessibleDescription(
      'Only people who can change the structure of the document can rename a region.',
    );
    expect((await h.named()).filter(([name]) => name === 'renameRegion')).toEqual([]);
  });

  test('says when the region may not be edited although the structure may be changed (criterion 5)', async ({
    page,
  }) => {
    const readOnlyHere = {
      ...EDITOR,
      scopes: { body: EDITOR.scopes.body, 'region:r1': ['view', 'comment'] },
    };
    const h = await open(page, { extended: true, regions: REGIONS, permissions: readOnlyHere });
    await h.exec('view.permissions');
    const pane = page.locator('.de-pane[data-pane="permissions"]');
    await pane.locator('[data-region="r1"]').getByRole('button').click();
    await expect(pane.getByLabel('Name of the region')).toBeDisabled();
    await expect(pane.getByLabel('Name of the region')).toHaveAccessibleDescription(
      'You cannot edit this region, so you cannot rename it.',
    );
  });
});
