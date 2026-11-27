/**
 * The ribbon layout of the toolbar (`toolbar="ribbon"`, ADR 0490; 13 §3). The tabs follow the
 * WAI-ARIA tabs pattern, the commands of the open tab are one toolbar with roving focus, the groups
 * carry their names, the page lies centred on a grey canvas, and nothing of the other layouts
 * changes. Run with `DOCEDIT_UI_PORT=57250 pnpm exec playwright test -c packages/ui/playwright.config.ts
 * packages/ui/e2e/ribbon.spec.ts`.
 */
import type { Page } from '@playwright/test';
import { axe, expect, focusSurface, focused, open, test } from './helpers.ts';

const TAB_NAMES = ['Home', 'Insert', 'Layout', 'References', 'Review', 'View'];

async function tabNames(page: Page): Promise<string[]> {
  return page.getByRole('tab').allTextContents();
}

test.describe('the ribbon tabs (WAI-ARIA tabs pattern)', () => {
  test('shows Home first and the other task tabs in order, one tab stop, Home selected', async ({
    page,
  }) => {
    await open(page, { toolbar: 'ribbon', extended: true });
    const names = await tabNames(page);
    expect(names[0]).toBe('Home');
    const task = names.filter((n) => TAB_NAMES.includes(n));
    expect(task).toEqual(TAB_NAMES.filter((n) => task.includes(n)));
    await expect(page.getByRole('tablist', { name: 'Command groups' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Home' })).toHaveAttribute('aria-selected', 'true');
    const stops = await page.locator('[role="tab"][tabindex="0"]').count();
    expect(stops).toBe(1);
    const panel = page.getByRole('tabpanel');
    await expect(panel).toHaveAttribute('aria-labelledby', /.+/);
  });

  test('arrow keys, Home and End move between tabs and select them', async ({ page }) => {
    await open(page, { toolbar: 'ribbon', extended: true });
    await page.getByRole('tab', { name: 'Home' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Insert' })).toBeFocused();
    await expect(page.getByRole('tab', { name: 'Insert' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByRole('toolbar', { name: 'Insert commands' })).toBeVisible();
    await page.keyboard.press('End');
    const last = (await tabNames(page)).at(-1)!;
    await expect(page.getByRole('tab', { name: last, exact: true })).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Home' })).toBeFocused();
    await page.keyboard.press('Home');
    await expect(page.getByRole('tab', { name: 'Home' })).toBeFocused();
    await page.keyboard.press('Escape');
    expect((await focused(page)).className).toContain('de-editing-surface');
  });
});

test.describe('the commands of a tab', () => {
  test('are one toolbar in named groups, with one tab stop and roving focus across the groups', async ({
    page,
  }) => {
    await open(page, { toolbar: 'ribbon', extended: true });
    const toolbar = page.getByRole('toolbar', { name: 'Home commands' });
    await expect(toolbar).toBeVisible();
    const groups = toolbar.getByRole('group');
    expect(await groups.count()).toBeGreaterThan(1);
    await expect(toolbar.getByRole('group', { name: 'Edit' })).toBeVisible();
    await expect(toolbar.getByRole('group', { name: 'Font' })).toBeVisible();
    // Every command has its icon over its label.
    const buttons = toolbar.getByRole('button');
    const count = await buttons.count();
    expect(count).toBeGreaterThan(3);
    for (let i = 0; i < count; i++)
      await expect(buttons.nth(i).locator('svg.de-icon')).toHaveCount(1);
    // One tab stop.
    expect(await toolbar.locator('button[tabindex="0"]').count()).toBe(1);
    // Tab from the tab strip enters it; the arrow keys cross from one group to the next.
    await page.getByRole('tab', { name: 'Home' }).focus();
    await page.keyboard.press('Tab');
    const first = await focused(page);
    expect(first.inside).toBe('toolbar');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    const moved = await focused(page);
    expect(moved.command).not.toBe(first.command);
    await page.keyboard.press('End');
    const end = await focused(page);
    await page.keyboard.press('ArrowRight');
    expect((await focused(page)).command).toBe(first.command);
    expect(end.command).not.toBe(first.command);
    await page.keyboard.press('Escape');
    expect((await focused(page)).className).toContain('de-editing-surface');
  });

  test('run the command, keep the selection, and show the pressed state', async ({ page }) => {
    const h = await open(page, { toolbar: 'ribbon', extended: true });
    await focusSurface(page);
    await h.setSelection({ empty: false, marks: ['bold'] });
    const bold = page
      .getByRole('toolbar', { name: 'Home commands' })
      .locator('button[data-command-id="format.bold"]');
    await expect(bold).toHaveAttribute('aria-pressed', 'true');
    await bold.click();
    expect(await h.runs()).toContain('bold');
  });

  test('a contextual group is a tab of its own, only while the selection is in its object', async ({
    page,
  }) => {
    const h = await open(page, { toolbar: 'ribbon' });
    await h.register('picture.sample', 'command.format.bold', false, { group: 'picture' });
    await focusSurface(page);
    const tab = page.locator('[role="tab"][data-group="picture"]');
    await expect(tab).toHaveCount(0);
    await h.setSelection({ contexts: ['picture'] });
    await expect(tab).toBeVisible();
    await expect(tab).toHaveAttribute('data-contextual', '');
    expect((await focused(page)).className).toContain('de-editing-surface');
    await h.setSelection({ contexts: [] });
    await expect(tab).toHaveCount(0);
  });
});

test.describe('the look of the ribbon', () => {
  test('puts the page, centred, on a canvas of another colour, and a status bar under it', async ({
    page,
  }) => {
    await open(page, { toolbar: 'ribbon', extended: true, width: 1200 });
    const shell = page.locator('.de-shell');
    await expect(shell).toHaveAttribute('data-toolbar', 'ribbon');
    const colours = await page.evaluate(() => {
      const root = document.getElementById('host')!.shadowRoot!;
      const canvas = getComputedStyle(root.querySelector('.de-workspace')!).backgroundColor;
      const sheet = getComputedStyle(root.querySelector('.de-page')!).backgroundColor;
      return { canvas, sheet };
    });
    expect(colours.canvas).not.toBe(colours.sheet);
    const work = await page.locator('.de-workspace').boundingBox();
    const sheet = await page.locator('.de-page').boundingBox();
    expect(work).not.toBeNull();
    expect(sheet).not.toBeNull();
    expect(sheet!.width).toBeLessThan(work!.width);
    const left = sheet!.x - work!.x;
    const right = work!.x + work!.width - (sheet!.x + sheet!.width);
    expect(Math.abs(left - right)).toBeLessThan(4);
    const status = await page.locator('.de-status').boundingBox();
    expect(status!.y).toBeGreaterThan(sheet!.y + sheet!.height - 1);
  });

  test('wraps groups instead of hiding commands in a menu when the window is narrow', async ({
    page,
  }) => {
    await open(page, { toolbar: 'ribbon', extended: true, width: 420 });
    await expect(page.locator('.de-toolbar-panel .de-more')).toBeHidden();
    const toolbar = page.getByRole('toolbar', { name: 'Home commands' });
    const box = await toolbar.boundingBox();
    const buttons = toolbar.getByRole('button');
    const n = await buttons.count();
    for (let i = 0; i < n; i++) {
      const b = await buttons.nth(i).boundingBox();
      expect(b, `button ${i}`).not.toBeNull();
      expect(b!.x + b!.width).toBeLessThanOrEqual(box!.x + box!.width + 1);
    }
  });

  test('has no accessibility violations in light, dark and high contrast', async ({ page }) => {
    for (const theme of ['light', 'dark', 'high-contrast'] as const) {
      await open(page, { toolbar: 'ribbon', extended: true, theme });
      expect(await axe(page), theme).toEqual([]);
    }
  });
});

test.describe('the other layouts are unchanged', () => {
  test('the compact and the full layouts carry no ribbon marks', async ({ page }) => {
    for (const toolbar of ['compact', 'full'] as const) {
      await open(page, { toolbar, extended: true });
      await expect(page.locator('.de-shell')).not.toHaveAttribute('data-toolbar', /.*/);
      await expect(page.locator('.de-ribbon, .de-ribbon-group')).toHaveCount(0);
    }
  });

  test('switching to the ribbon and back keeps the selection and the single mount', async ({
    page,
  }) => {
    const h = await open(page, { toolbar: 'compact', extended: true });
    await focusSurface(page);
    await h.setSelection({ empty: false, marks: ['italic'] });
    const selection = await h.selection();
    await h.setSettings({ toolbar: 'ribbon' });
    await expect(page.getByRole('tablist')).toBeVisible();
    await h.setSettings({ toolbar: 'compact' });
    await expect(page.getByRole('toolbar', { name: 'Editing' })).toBeVisible();
    expect(await h.selection()).toEqual(selection);
    expect((await h.calls()).filter((c) => c === 'mountBody')).toHaveLength(1);
  });

  test('Alt+F10 still moves focus into the format bar near the selection', async ({ page }) => {
    const h = await open(page, { toolbar: 'ribbon', extended: true });
    await focusSurface(page);
    await h.setSelection({ empty: false, marks: [] });
    await expect(page.locator('[data-mini-toolbar]')).toBeVisible();
    await page.keyboard.press('Alt+F10');
    await expect(page.locator('[data-mini-toolbar] button').first()).toBeFocused();
    await page.keyboard.press('Escape');
    expect((await focused(page)).className).toContain('de-editing-surface');
  });
});
