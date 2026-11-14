/**
 * The compact toolbar and the commands behind it (UX-006, UX-003, UX-004), in the shadow root of a
 * host element, under the strict policy of spike S2.
 */
import { expect, open, test } from './helpers.ts';

const COMMANDS = [
  'Undo',
  'Redo',
  'Select all',
  'Bold',
  'Italic',
  'Footnote',
  'Edit header',
  'Navigation',
  'Recovered edits',
  'Keyboard shortcuts',
];
const VIEW_ONLY = { scope: 'body', caps: ['view'], limit: 'role' } as const;
const EDIT = { scope: 'body', caps: ['view', 'comment', 'suggest', 'edit'], limit: null } as const;

test.describe('the compact toolbar (UX-006)', () => {
  test('is one row generated from the registry, and exposes the toolbar part', async ({ page }) => {
    await open(page);
    const toolbar = page.getByRole('toolbar', { name: 'Editing' });
    await expect(toolbar).toBeVisible();
    const buttons = toolbar.locator('button.de-tool:not([hidden])');
    await expect(buttons).toHaveText(COMMANDS);
    const tops = await buttons.evaluateAll((els) =>
      els.map((el) => Math.round(el.getBoundingClientRect().top)),
    );
    expect(new Set(tops).size).toBe(1);
    // `#host::part(toolbar)` in the host page styles it (02 §3).
    expect(await toolbar.evaluate((el) => getComputedStyle(el).outlineColor)).toBe('rgb(1, 2, 3)');
  });

  test('runs the same command path as exec, by pointer and by keyboard', async ({ page }) => {
    const h = await open(page);
    const toolbar = page.getByRole('toolbar', { name: 'Editing' });
    await toolbar.getByRole('button', { name: 'Bold' }).click();
    await toolbar.getByRole('button', { name: 'Italic' }).focus();
    await page.keyboard.press('Enter');
    await toolbar.getByRole('button', { name: 'Bold' }).focus();
    await page.keyboard.press(' ');
    expect(await h.exec('format.italic')).toEqual({ ran: true, reason: null });
    expect(await h.runs()).toEqual(['bold', 'italic', 'bold', 'italic']);
  });

  test('is one tab stop: arrow keys, Home and End move, Escape returns to the page', async ({
    page,
  }) => {
    await open(page);
    await page.locator('h1').click();
    await page.keyboard.press('Tab');
    const focused = () =>
      page.evaluate(() => {
        const active = document.getElementById('host')!.shadowRoot!
          .activeElement as HTMLElement | null;
        return active
          ? (active.getAttribute('aria-label') ?? active.textContent?.trim() ?? '')
          : '';
      });
    expect(await focused()).toBe('Undo');
    // Focus is visible on the control that has it.
    const outline = await page.evaluate(() => {
      const active = document.getElementById('host')!.shadowRoot!.activeElement!;
      const style = getComputedStyle(active);
      return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
    });
    expect(outline.style).not.toBe('none');
    expect(outline.width).toBeGreaterThanOrEqual(2);
    await page.keyboard.press('ArrowRight');
    expect(await focused()).toBe('Redo');
    await page.keyboard.press('End');
    expect(await focused()).toBe(COMMANDS.at(-1));
    await page.keyboard.press('ArrowRight');
    expect(await focused()).toBe('Undo');
    await page.keyboard.press('ArrowLeft');
    expect(await focused()).toBe(COMMANDS.at(-1));
    await page.keyboard.press('Home');
    expect(await focused()).toBe('Undo');
    // One tab stop: Tab leaves the toolbar for the editing surface.
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Tab');
    expect(
      await page.evaluate(
        () => document.getElementById('host')!.shadowRoot!.activeElement?.className ?? '',
      ),
    ).toContain('de-editing-surface');
    // Shift+Tab comes back to the control that had focus last.
    await page.keyboard.press('Shift+Tab');
    expect(await focused()).toBe('Redo');
    await page.keyboard.press('Escape');
    expect(
      await page.evaluate(
        () => document.getElementById('host')!.shadowRoot!.activeElement?.className ?? '',
      ),
    ).toContain('de-editing-surface');
  });

  test('shows an active command to assistive technology and visually', async ({ page }) => {
    const h = await open(page);
    const bold = page.getByRole('button', { name: 'Bold' });
    const italic = page.getByRole('button', { name: 'Italic' });
    await expect(bold).toHaveAttribute('aria-pressed', 'false');
    await h.setSelection({ marks: ['bold'] });
    await expect(bold).toHaveAttribute('aria-pressed', 'true');
    await expect(italic).toHaveAttribute('aria-pressed', 'false');
    const look = (el: HTMLElement) => {
      const s = getComputedStyle(el);
      return `${s.backgroundColor}|${s.borderTopColor}|${s.boxShadow}`;
    };
    expect(await bold.evaluate(look)).not.toBe(await italic.evaluate(look));
    await bold.click();
    await expect(bold).toHaveAttribute('aria-pressed', 'false');
  });

  test('keeps the commands that do not fit reachable through "More"', async ({ page }) => {
    const h = await open(page, { width: 420 });
    const toolbar = page.getByRole('toolbar', { name: 'Editing' });
    const more = toolbar.locator('button.de-more');
    await expect(more).toBeVisible();
    const shown = await toolbar
      .locator('button.de-tool:not(.de-more):not([hidden])')
      .allTextContents();
    expect(shown.length).toBeLessThan(COMMANDS.length);
    // Nothing overflows the row.
    const box = await toolbar.boundingBox();
    const moreBox = await more.boundingBox();
    expect(moreBox!.x + moreBox!.width).toBeLessThanOrEqual(box!.x + box!.width + 0.5);
    await expect(more).toHaveAccessibleName(`More ${COMMANDS.length - shown.length} more commands`);
    await more.focus();
    await page.keyboard.press('ArrowDown');
    const menu = page.getByRole('menu', { name: 'More commands' });
    await expect(menu).toBeVisible();
    const inMenu = (await menu.getByRole('menuitem').allTextContents()).concat(
      await menu.getByRole('menuitemcheckbox').allTextContents(),
    );
    // Every command is in the row or in the menu, once.
    expect([...shown, ...inMenu].sort()).toEqual([...COMMANDS].sort());
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(more).toBeFocused();
    // Run one from the menu by keyboard: End reaches the last item, then the arrow keys reach
    // Navigation wherever it sits in the menu (later commands of the view group follow it).
    await page.keyboard.press('ArrowDown');
    const items = menu.locator('[data-menu-item]');
    await page.keyboard.press('End');
    await expect(items.last()).toBeFocused();
    const order = (await items.allTextContents()).map((t) => t.trim());
    const navigation = order.indexOf('Navigation');
    expect(navigation).toBeGreaterThanOrEqual(0);
    for (let i = order.length - 1; i > navigation; i--) await page.keyboard.press('ArrowUp');
    await expect(items.nth(navigation)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('.de-outline')).toBeVisible();
    expect(await h.state('view.outline')).toMatchObject({ active: true });
  });

  test('drops a removed command and shows a new one without a reload', async ({ page }) => {
    const h = await open(page);
    const toolbar = page.getByRole('toolbar', { name: 'Editing' });
    await h.unregister('edit.selectAll');
    await expect(toolbar.getByRole('button', { name: 'Select all' })).toHaveCount(0);
    await h.register('ext.sample');
    await expect(toolbar.locator('[data-command-id="ext.sample"]')).toBeVisible();
  });

  test('follows the toolbar setting without a remount', async ({ page }) => {
    const h = await open(page);
    await h.setSettings({ toolbar: 'none' });
    await expect(page.getByRole('toolbar')).toHaveCount(0);
    // The commands stay reachable through the registry (UX-005, phase 1b, builds on this).
    expect(await h.exec('format.bold')).toEqual({ ran: true, reason: null });
    await h.setSettings({ toolbar: 'compact' });
    await expect(page.getByRole('toolbar', { name: 'Editing' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Bold' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('takes --de- properties set on the element or on any ancestor (02 §3)', async ({ page }) => {
    await open(page);
    const border = () =>
      page.locator('.de-toolbar').evaluate((el) => getComputedStyle(el).borderBlockEndColor);
    expect(await border()).toBe('rgb(208, 215, 222)');
    await page.evaluate(() => document.body.style.setProperty('--de-border', 'rgb(7, 8, 9)'));
    expect(await border()).toBe('rgb(7, 8, 9)');
    await page.evaluate(() =>
      document.getElementById('host')!.style.setProperty('--de-border', 'rgb(10, 11, 12)'),
    );
    expect(await border()).toBe('rgb(10, 11, 12)');
  });

  test('keeps the names the element of spike S1 uses', async ({ page }) => {
    await open(page);
    await expect(page.locator('button[data-command="insertFootnote"]')).toBeVisible();
    await page.locator('button[data-command="outline"]').click();
    await expect(page.locator('.de-outline')).toContainText('Scope');
    await expect(page.locator('.de-toolbar')).toHaveCSS('display', 'flex');
  });
});

test.describe('commands follow the user access (UX-004)', () => {
  test('a view-only user sees content commands disabled, with the reason', async ({ page }) => {
    const h = await open(page, { access: VIEW_ONLY });
    const bold = page.getByRole('button', { name: 'Bold' });
    await expect(bold).toHaveAttribute('aria-disabled', 'true');
    await expect(bold).toHaveAccessibleDescription(
      'You can view this part of the document but not change it.',
    );
    for (const name of ['Undo', 'Redo', 'Italic', 'Footnote'])
      await expect(page.getByRole('button', { name })).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByRole('button', { name: 'Select all' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
    // A real click on the control (Playwright would otherwise wait for it to be enabled).
    await bold.click({ force: true });
    expect(await h.runs()).toEqual([]);
    expect(await h.state('format.bold')).toMatchObject({ enabled: false, reason: 'no-access' });
  });

  test('states follow the caret into a region the user may not edit within one frame', async ({
    page,
  }) => {
    await open(page);
    const disabled = await page.evaluate(() => {
      const h = (window as unknown as { harness: { moveTo: (a: unknown, s: unknown) => void } })
        .harness;
      const root = document.getElementById('host')!.shadowRoot!;
      const bold = root.querySelector('[data-command-id="format.bold"]')!;
      const before = bold.getAttribute('aria-disabled');
      h.moveTo(
        { scope: 'region:r1', caps: ['view', 'comment'], limit: 'region' },
        {
          scope: 'region',
          region: 'Terms',
        },
      );
      // The core notifies in the next frame; the shell must have updated by the end of it.
      return new Promise<[string | null, string | null]>((resolve) =>
        requestAnimationFrame(() => resolve([before, bold.getAttribute('aria-disabled')])),
      );
    });
    expect(disabled).toEqual([null, 'true']);
    await expect(page.getByRole('button', { name: 'Bold' })).toHaveAccessibleDescription(
      'You have no permission to change this part of the document.',
    );
  });

  test('a permission change disables commands without a reload and is announced', async ({
    page,
  }) => {
    const h = await open(page);
    const status = page.locator('.de-shell > [role="status"]');
    await h.setAccess(VIEW_ONLY);
    await expect(page.getByRole('button', { name: 'Bold' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await expect(status).toHaveText('You can no longer change this part of the document.');
    await h.setAccess(EDIT);
    await expect(page.getByRole('button', { name: 'Bold' })).not.toHaveAttribute('aria-disabled');
    await expect(status).toHaveText('You can now change this part of the document.');
    // Moving the caret into another scope is not a permission change: nothing is announced.
    // It is announced as a read-only part instead (PRM-026 criterion 5).
    await h.moveTo({ scope: 'region:r1', caps: ['view'], limit: 'region' }, { scope: 'region' });
    await h.frames(2);
    await expect(status).not.toHaveText(/no longer|can now/);
    await expect(status).toHaveText(/You cannot edit this part/);
  });
});
