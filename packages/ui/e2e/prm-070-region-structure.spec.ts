/**
 * Renaming a region and adding styles for a person who may edit only one region (PRM-070, criteria
 * 1 to 3; ADR 0424; decision 279). The access object decides what is offered: the scope
 * `region:<id>` holding `structure` turns the rename on, the scope `defs` holding `structure.add`
 * turns "new style" on and nothing else in the styles pane, and a person with `manage` sees two
 * checkboxes on a grant of the role `editor` and on no other role. The core is the shell's fake
 * core; the engine's own rules are `packages/engine/test/prm-070.region-structure.test.ts`.
 * Run with `pnpm exec playwright test -c packages/ui/playwright.config.ts
 * packages/ui/e2e/prm-070-region-structure.spec.ts --project=chromium` (DOCEDIT_UI_PORT in 56500 to 56509).
 */
import type { Page } from '@playwright/test';
import { expect, open, test } from './helpers.ts';

const REGIONS = [
  { id: 'r1', title: 'Terms', policy: 'inherit' as const, order: 0, state: 'draft' as const },
];
const STYLES = [
  { id: 'Normal', name: 'Normal', kind: 'paragraph' as const, basedOn: null },
  { id: 'Clause', name: 'Clause', kind: 'paragraph' as const, basedOn: 'Normal' },
];
/** A viewer of the document with a grant on `r1`: the access object of ADR 0424. */
const regionOnly = (region: string[], defs: string[] = ['view']) => ({
  rev: 3,
  docRole: 'viewer',
  caps: ['view'],
  scopes: { doc: ['view'], body: ['view'], defs, 'region:r1': region },
});
const OWNER = {
  rev: 3,
  docRole: 'owner',
  caps: ['view', 'comment', 'suggest', 'edit', 'structure', 'manage'],
  scopes: {
    body: ['view', 'comment', 'suggest', 'edit'],
    'region:r1': ['view', 'comment', 'suggest', 'edit'],
  },
};

const permissions = (page: Page) => page.locator('.de-pane[data-pane="permissions"]');

test.describe('renaming from the scope of the region (PRM-070, criterion 1)', () => {
  test('offers the rename when the region scope holds `structure`, without document-level structure', async ({
    page,
  }) => {
    const h = await open(page, {
      extended: true,
      regions: REGIONS,
      permissions: regionOnly(['view', 'comment', 'suggest', 'edit', 'structure']),
    });
    await h.exec('view.permissions');
    const pane = permissions(page);
    await pane.locator('[data-region="r1"]').getByRole('button').click();
    const field = pane.getByLabel('Name of the region');
    await expect(field).toBeEnabled();
    await field.fill('Conditions');
    await field.press('Enter');
    expect(await h.named()).toContainEqual(['renameRegion', { region: 'r1', title: 'Conditions' }]);
  });

  test('is absent without the listing: disabled, with the text of `permissions.rename.noStructure`', async ({
    page,
  }) => {
    const h = await open(page, {
      extended: true,
      regions: REGIONS,
      permissions: regionOnly(['view', 'comment', 'suggest', 'edit']),
    });
    await h.exec('view.permissions');
    const pane = permissions(page);
    await pane.locator('[data-region="r1"]').getByRole('button').click();
    const field = pane.getByLabel('Name of the region');
    await expect(field).toBeDisabled();
    await expect(field).toHaveAccessibleDescription(
      'Only people who can change the structure of the document can rename a region.',
    );
    expect((await h.named()).filter(([name]) => name === 'renameRegion')).toEqual([]);
  });
});

test.describe('style controls for a person who may add styles (PRM-070, criterion 2)', () => {
  const stylesPane = (page: Page) => page.locator('.de-pane[data-pane="styles"]');

  test('offers "New style" and no change or deletion of an existing style', async ({ page }) => {
    const h = await open(page, {
      extended: true,
      styles: STYLES,
      styleEdit: {},
      permissions: regionOnly(['view', 'comment', 'suggest', 'edit'], ['view', 'structure.add']),
    });
    await h.exec('view.styles');
    const p = stylesPane(page);
    await expect(p.getByRole('button', { name: 'New style' })).toBeVisible();
    await expect(p.locator('[data-style-action="change"]')).toHaveCount(0);
    await expect(p.locator('[data-style-action="delete"]')).toHaveCount(0);
    await expect(p.locator('[data-styles="add-only"]')).toContainText('You may add a style');
    // Applying an existing style is still possible.
    await expect(p.getByRole('button', { name: /^Clause/ })).toBeVisible();
  });

  test('offers all three controls to a person with structure, and none of the add-only text', async ({
    page,
  }) => {
    const h = await open(page, {
      extended: true,
      styles: STYLES,
      styleEdit: {},
      permissions: OWNER,
    });
    await h.exec('view.styles');
    const p = stylesPane(page);
    await expect(p.locator('[data-style-action="change"]')).toHaveCount(STYLES.length);
    await expect(p.locator('[data-style-action="delete"]')).toHaveCount(STYLES.length);
    await expect(p.locator('[data-styles="add-only"]')).toHaveCount(0);
  });
});

test.describe('the two checkboxes of a grant (PRM-070, criterion 3)', () => {
  test('are shown for the role editor and for no other, and saved with the grant', async ({
    page,
  }) => {
    const h = await open(page, {
      extended: true,
      regions: REGIONS,
      permissions: OWNER,
      grants: [
        { region: 'r1', principal: 'user:u1', role: 'editor' },
        { region: 'r1', principal: 'user:u2', role: 'viewer' },
      ],
    });
    await h.exec('view.permissions');
    const pane = permissions(page);
    await pane.locator('[data-region="r1"]').getByRole('button').click();

    const editor = pane.locator('.de-grant[data-principal="user:u1"]');
    const viewer = pane.locator('.de-grant[data-principal="user:u2"]');
    await expect(editor.getByRole('checkbox', { name: 'Rename the region' })).not.toBeChecked();
    await expect(editor.getByRole('checkbox', { name: 'Add styles' })).not.toBeChecked();
    await expect(viewer.locator('[data-structure]')).toHaveCount(0);

    await editor.getByRole('checkbox', { name: 'Add styles' }).check();
    await expect(pane.locator('[data-status="permissions"]')).toHaveText('Permissions saved.');
    const saves = await h.grantSaves();
    expect(saves.at(-1)).toMatchObject({
      grants: expect.arrayContaining([
        expect.objectContaining({ principal: 'user:u1', role: 'editor', structure: ['defs.add'] }),
        expect.objectContaining({ principal: 'user:u2', role: 'viewer' }),
      ]),
    });
    const viewerSaved = saves.at(-1)?.grants.find((g) => g.principal === 'user:u2');
    expect(viewerSaved).not.toHaveProperty('structure');
    await expect(editor.getByRole('checkbox', { name: 'Add styles' })).toBeChecked();

    // Taking the listing away again removes the member.
    await editor.getByRole('checkbox', { name: 'Add styles' }).uncheck();
    await expect(editor.getByRole('checkbox', { name: 'Add styles' })).not.toBeChecked();
    const last = (await h.grantSaves()).at(-1);
    expect(last?.grants.find((g) => g.principal === 'user:u1')).not.toHaveProperty('structure');
  });

  test('are offered on the add form only while the role is editor', async ({ page }) => {
    const h = await open(page, {
      extended: true,
      regions: REGIONS,
      permissions: OWNER,
      grants: [],
    });
    await h.exec('view.permissions');
    const pane = permissions(page);
    await pane.locator('[data-region="r1"]').getByRole('button').click();
    const form = pane.locator('form').filter({ hasText: 'Give a role' });
    const role = form.getByRole('combobox', { name: 'Role' });
    await expect(role).toHaveValue('editor');
    await expect(form.getByRole('checkbox', { name: 'Rename the region' })).toBeVisible();
    await expect(form.getByRole('checkbox', { name: 'Add styles' })).toBeVisible();
    for (const other of ['viewer', 'commenter', 'suggester'])
      await test.step(other, async () => {
        await role.selectOption(other);
        await expect(form.locator('[data-structure]')).toHaveCount(0);
      });
  });

  test('are not shown to a person without `manage`', async ({ page }) => {
    const h = await open(page, {
      extended: true,
      regions: REGIONS,
      permissions: { ...OWNER, caps: ['view', 'comment', 'suggest', 'edit', 'structure'] },
      grants: [{ region: 'r1', principal: 'user:u1', role: 'editor' }],
    });
    await h.exec('view.permissions');
    const pane = permissions(page);
    await pane.locator('[data-region="r1"]').getByRole('button').click();
    await expect(pane.locator('.de-grant[data-principal="user:u1"]')).toBeVisible();
    await expect(pane.locator('[data-structure]')).toHaveCount(0);
  });
});
