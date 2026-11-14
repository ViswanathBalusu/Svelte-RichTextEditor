/**
 * axe on every pane and dialog the shell builds itself (UX-068, criterion 1; V3 group 3 fix). The
 * panes are those of src/shell/panes.ts with code in packages/ui/src (styles, permissions,
 * recovered, shortcuts, fill; the outline is in ux-068-axe-states.spec.ts). The comments, history
 * and assistant panes come from a port and have no shell code. The dialogs are those App.svelte
 * mounts (language, region, comment box; the export dialog and the command search are in
 * ux-068-axe-states.spec.ts). Each state is checked with content in it, and with its error shown
 * where it has one. Run from the repository root, one browser at a time or all three:
 * `DOCEDIT_UI_PORT=57041 pnpm exec playwright test -c packages/ui/playwright.config.ts ux-068-axe-panes-dialogs`.
 */
import { axe, expect, open, test } from './helpers.ts';

const STYLES = [
  { id: 'Normal', name: 'Normal', kind: 'paragraph' as const },
  { id: 'Heading1', name: 'Heading 1', kind: 'paragraph' as const },
  { id: 'Strong', name: 'Strong', kind: 'character' as const },
  { id: 'Grid', name: 'Grid table', kind: 'table' as const },
];

const REGIONS = [
  {
    id: 'r1',
    title: 'Terms',
    policy: 'restricted' as const,
    order: 0,
    state: 'draft' as const,
    editors: { roles: ['owner'], principals: ['user:u1', 'group:legal'] },
  },
  {
    id: 'r2',
    title: 'Annex',
    policy: 'inherit' as const,
    order: 1,
    state: 'draft' as const,
    editors: { roles: ['editor', 'owner'], principals: [] },
  },
  { id: 'r3', title: null, policy: 'confidential' as const, order: 2, state: 'draft' as const },
];
const OWNER = {
  rev: 3,
  docRole: 'owner',
  caps: ['view', 'comment', 'suggest', 'edit', 'structure', 'manage'],
  scopes: {
    body: ['view', 'comment', 'suggest', 'edit'],
    'region:r1': ['view', 'comment'],
    'region:r2': ['view', 'comment', 'suggest', 'edit'],
    'region:r3': [],
  },
};

const FILL = {
  active: true,
  inactive: null,
  fields: [
    { id: 'f1', label: 'Name', required: true, filled: true, invalid: null },
    { id: 'f2', label: 'Date of birth', required: true, filled: false, invalid: null },
    { id: 'f3', label: 'Amount', required: true, filled: true, invalid: 'range' as const },
    { id: 'f4', label: 'Notes', required: false, filled: false, invalid: null },
  ],
};

test.describe('axe finds no violation in each pane (UX-068, criterion 1)', () => {
  test('with the styles pane open', async ({ page }) => {
    const h = await open(page, { extended: true, styles: STYLES });
    expect(await h.exec('view.styles')).toEqual({ ran: true, reason: null });
    const pane = page.locator('.de-pane[data-pane="styles"]');
    await expect(pane).toBeVisible();
    // An empty pane would pass vacuously: the styles are listed.
    await expect(pane).toContainText('Heading 1');
    expect(await axe(page)).toEqual([]);
  });

  test('with the permissions pane open, a region expanded and the directory search listed', async ({
    page,
  }) => {
    const h = await open(page, {
      extended: true,
      regions: REGIONS,
      permissions: OWNER,
      grants: [{ region: 'r1', principal: 'user:u1', role: 'editor' }],
    });
    expect(await h.exec('view.permissions')).toEqual({ ran: true, reason: null });
    const pane = page.locator('.de-pane[data-pane="permissions"]');
    await expect(pane.locator('[data-region]').first()).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await pane.locator('[data-region="r1"]').getByRole('button').click();
    await expect(pane.locator('.de-grant[data-principal="user:u1"]')).toContainText('Ada Lovelace');
    await pane.getByRole('combobox', { name: 'Find a person or group' }).fill('l');
    await expect(
      pane.getByRole('listbox', { name: 'People and groups found' }).getByRole('option'),
    ).toHaveText([/Ada Lovelace/, /Legal team/]);
    expect(await axe(page)).toEqual([]);
  });

  test('with the recovered pane open and an item of each kind listed', async ({ page }) => {
    const h = await open(page, {
      extended: true,
      regions: [{ id: 'r1', title: 'Terms', policy: 'restricted', order: 0, state: 'draft' }],
    });
    await h.setAside([
      { id: 'i1', reason: 'rebase', commit: null, text: 'My words', seq: 4 },
      {
        id: 'i2',
        reason: 'permission_denied',
        commit: 'c1',
        text: 'Other words',
        seq: 5,
        scope: 'region:r1',
        scopes: ['region:r1', 'defs'],
        changedBy: 'u2',
        changedAt: '2026-11-13T09:30:00.000Z',
      },
    ]);
    expect(await h.exec('view.recovered')).toEqual({ ran: true, reason: null });
    const pane = page.locator('.de-pane[data-pane="recovered"]');
    await expect(pane.locator('[data-item]')).toHaveCount(2);
    expect(await axe(page)).toEqual([]);
  });

  test('with the shortcuts pane open', async ({ page }) => {
    const h = await open(page, { extended: true });
    expect(await h.exec('view.shortcuts')).toEqual({ ran: true, reason: null });
    const pane = page.locator('.de-pane[data-pane="shortcuts"]');
    await expect(pane).toBeVisible();
    await expect(pane.locator('kbd').first()).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });

  test('with the fill pane open from the filling-in bar', async ({ page }) => {
    await open(page, { extended: true, fill: FILL });
    const bar = page.getByRole('region', { name: 'Filling in' });
    expect(await axe(page)).toEqual([]);
    await bar.getByRole('button', { name: 'What is left' }).click();
    const pane = page.locator('.de-pane[data-pane="fill"]');
    await expect(pane.locator('[data-field]')).toHaveCount(2);
    expect(await axe(page)).toEqual([]);
  });
});

test.describe('axe finds no violation in each dialog (UX-068, criterion 1)', () => {
  test('with the language dialog open, valid and then with its error shown', async ({ page }) => {
    const h = await open(page, { extended: true, language: 'en-GB' });
    await h.setSelection({ lang: 'de-CH' });
    await page.locator('.de-status [data-status="language"]').click();
    const dialog = page.getByRole('dialog', { name: 'Language of the selected text' });
    await expect(dialog).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await dialog.getByRole('textbox', { name: 'Language tag' }).fill('not a tag!');
    await expect(dialog.getByText('This is not a valid language tag.')).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });

  test('with the region dialog open, and then with its error shown', async ({ page }) => {
    await open(page, {
      extended: true,
      regions: [],
      permissions: OWNER,
      toolbar: 'full',
      selection: { empty: false },
    });
    await page.getByRole('tab', { name: 'Insert' }).click();
    const button = page.getByRole('tabpanel').locator('[data-command-id="insert.region"]');
    await button.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Make a region' });
    await expect(dialog).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await page.keyboard.press('Enter');
    await expect(dialog.getByText('Enter a title.')).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });

  test('with the comment box open, empty and then with the mention list shown', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, comments: true });
    expect(await h.exec('review.comment')).toEqual({ ran: true, reason: null });
    const box = page.locator('[data-dialog="comment"]');
    await expect(box).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await box.getByRole('textbox', { name: 'Comment' }).pressSequentially('Please ask @Gr');
    await expect(box.getByRole('option')).toHaveText([/Grace Hopper/]);
    expect(await axe(page)).toEqual([]);
  });
});
