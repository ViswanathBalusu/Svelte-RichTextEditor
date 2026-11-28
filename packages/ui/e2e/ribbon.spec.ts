/**
 * The ribbon layout of the toolbar (`toolbar="ribbon"`, ADR 0490; 13 §3). The tabs follow the
 * WAI-ARIA tabs pattern, the commands of the open tab are one toolbar with roving focus, the groups
 * carry their names, the page lies centred on a grey canvas, and nothing of the other layouts
 * changes. Run with `DOCEDIT_UI_PORT=57250 pnpm exec playwright test -c packages/ui/playwright.config.ts
 * packages/ui/e2e/ribbon.spec.ts`.
 */
import type { Page } from '@playwright/test';
import type { ParagraphFormatView } from '../src/core-api.ts';
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
    // Every command has its icon over its label; the lists of style and size show their value instead.
    const buttons = toolbar.getByRole('button');
    const count = await buttons.count();
    expect(count).toBeGreaterThan(3);
    for (let i = 0; i < count; i++) {
      const own = buttons.nth(i);
      if ((await own.getAttribute('data-command-id')) === 'format.applyStyle') continue;
      if ((await own.getAttribute('data-command-id')) === 'format.fontSize') continue;
      await expect(own.locator('svg[data-icon]')).toHaveCount(1);
    }
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

const PARAGRAPH: ParagraphFormatView = {
  count: 1,
  indentLeft: 0,
  indentRight: 0,
  indentFirstLine: 0,
  tabs: [],
  defaultTabStop: 720,
  page: null,
  editable: true,
  options: {
    align: 'start',
    spaceBefore: 0,
    spaceAfter: 0,
    lineSpacing: 1000,
    lineRule: 'multiple',
    keepNext: false,
    keepLines: false,
    pageBreakBefore: false,
    widowControl: true,
    contextualSpacing: false,
    borders: {},
    shading: null,
    mixed: [],
  },
};

const STYLES = [
  { id: 'Normal', name: 'Body text', kind: 'paragraph' as const },
  { id: 'Heading1', name: 'Heading 1', kind: 'paragraph' as const },
  { id: 'Heading2', name: 'Heading 2', kind: 'paragraph' as const },
  { id: 'Strong', name: 'Strong', kind: 'character' as const },
];

async function openHome(page: Page, theme?: 'light' | 'dark' | 'high-contrast') {
  const h = await open(page, {
    toolbar: 'ribbon',
    extended: true,
    paragraphFormat: PARAGRAPH,
    styles: STYLES,
    selection: { style: 'Body text', styleId: 'Normal' },
    ...(theme ? { theme } : {}),
  });
  const home = page.getByRole('toolbar', { name: 'Home commands' });
  // The commands beyond bold and italic load with the ribbon's strings, a moment after the editor.
  await expect(home.locator('button[data-command-id="format.underline"]')).toBeVisible();
  return { h, home };
}

test.describe('the Home tab (ADR 0490)', () => {
  test('lays out edit, styles, font and paragraph, as a word processor does', async ({ page }) => {
    const { home } = await openHome(page);
    const groups = await home
      .getByRole('group')
      .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));
    expect(groups.slice(0, 4)).toEqual(['Edit', 'Styles', 'Font', 'Paragraph']);
    for (const name of [
      'Underline',
      'Strikethrough',
      'Text colour',
      'Highlight',
      'Clear formatting',
      'Align start',
      'Centre',
      'Align end',
      'Justify',
      'Bulleted list',
      'Numbered list',
      'Decrease indent',
      'Increase indent',
    ])
      await expect(home.getByRole('button', { name, exact: true }), name).toBeVisible();
    // The style and the size are menu buttons that name their command and show their value.
    const style = home.locator('button[data-command-id="format.applyStyle"]');
    await expect(style).toHaveAttribute('aria-haspopup', 'menu');
    await expect(style).toHaveAccessibleName('Apply style: Body text');
    await expect(home.locator('button[data-command-id="format.fontSize"]')).toHaveAccessibleName(
      'Font size: Size',
    );
    // Still one tab stop across all of them, and every control has a name.
    expect(await home.locator('button[tabindex="0"]').count()).toBe(1);
    for (const button of await home.getByRole('button').all())
      expect(
        ((await button.getAttribute('aria-label')) ?? (await button.innerText()) ?? '').length,
      ).toBeGreaterThan(0);
  });

  test('Underline and Strikethrough change the text and show as pressed', async ({ page }) => {
    const { h, home } = await openHome(page);
    await focusSurface(page);
    await h.setSelection({ empty: false, marks: [] });
    const underline = home.getByRole('button', { name: 'Underline', exact: true });
    await expect(underline).toHaveAttribute('aria-pressed', 'false');
    await underline.click();
    await expect(underline).toHaveAttribute('aria-pressed', 'true');
    expect(await h.named()).toContainEqual(['underline', null]);
    await expect(home.getByRole('button', { name: 'Strikethrough', exact: true })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await home.getByRole('button', { name: 'Strikethrough', exact: true }).click();
    await expect(home.getByRole('button', { name: 'Strikethrough', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect((await h.selection()).marks).toEqual(['strike', 'underline']);
    // Clear formatting takes them off.
    await home.getByRole('button', { name: 'Clear formatting', exact: true }).click();
    expect((await h.selection()).marks).toEqual([]);
    await expect(underline).toHaveAttribute('aria-pressed', 'false');
  });

  test('the alignment buttons set the paragraph and show which one it has', async ({ page }) => {
    const { h, home } = await openHome(page);
    await focusSurface(page);
    const centre = home.getByRole('button', { name: 'Centre', exact: true });
    const start = home.getByRole('button', { name: 'Align start', exact: true });
    await expect(start).toHaveAttribute('aria-pressed', 'true');
    await expect(centre).toHaveAttribute('aria-pressed', 'false');
    await centre.click();
    expect(await h.named()).toContainEqual(['setParagraphFormat', { align: 'center' }]);
    await expect(centre).toHaveAttribute('aria-pressed', 'true');
    await expect(start).toHaveAttribute('aria-pressed', 'false');
  });

  test('the list and indent buttons ask the core for a list, and for a level or an indent', async ({
    page,
  }) => {
    const { h, home } = await openHome(page);
    await focusSurface(page);
    await home.getByRole('button', { name: 'Bulleted list', exact: true }).click();
    await home.getByRole('button', { name: 'Numbered list', exact: true }).click();
    await home.getByRole('button', { name: 'Increase indent', exact: true }).click();
    await home.getByRole('button', { name: 'Decrease indent', exact: true }).click();
    const named = await h.named();
    expect(named).toContainEqual(['applyList', { listKind: 'bullet' }]);
    expect(named).toContainEqual(['applyList', { listKind: 'number' }]);
    expect(named.map(([name]) => name)).toEqual(
      expect.arrayContaining(['listLevelUp', 'listLevelDown']),
    );
  });

  test('the style list opens with the arrow keys, lists the document’s paragraph styles and applies one', async ({
    page,
  }) => {
    const { h, home } = await openHome(page);
    await focusSurface(page);
    const button = home.locator('button[data-command-id="format.applyStyle"]');
    await button.focus();
    await page.keyboard.press('ArrowDown');
    const menu = page.getByRole('menu', { name: 'Apply style' });
    await expect(menu).toBeVisible();
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    const items = menu.getByRole('menuitemradio');
    await expect(items).toHaveText(['Body text', 'Heading 1', 'Heading 2']);
    // The current style is checked and has the focus.
    await expect(items.nth(0)).toHaveAttribute('aria-checked', 'true');
    await expect(items.nth(0)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(menu).toHaveCount(0);
    await expect(button).toBeFocused();
    expect(await h.named()).toContainEqual(['paragraphStyle', { style: 'Heading1' }]);
    await expect(button).toHaveAccessibleName('Apply style: Heading 1');
    // Escape closes it and gives the focus back; Tab and a click outside close it too.
    await page.keyboard.press('Enter');
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(button).toBeFocused();
    await button.click();
    await expect(menu).toBeVisible();
    await page.locator('.de-editing-surface').click({ position: { x: 5, y: 5 } });
    await expect(menu).toHaveCount(0);
  });

  test('the size list offers the sizes of the model and shows the one in use', async ({ page }) => {
    const { h, home } = await openHome(page);
    await focusSurface(page);
    const button = home.locator('button[data-command-id="format.fontSize"]');
    await button.click();
    const menu = page.getByRole('menu', { name: 'Font size' });
    await expect(menu.getByRole('menuitemradio')).toHaveCount(14);
    await menu.getByRole('menuitemradio', { name: '14', exact: true }).click();
    expect(await h.named()).toContainEqual(['fontSize', { fontSize: 280 }]);
    await expect(button).toHaveAccessibleName('Font size: 14');
    await button.click();
    await expect(menu.getByRole('menuitemradio', { name: '14', exact: true })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await menu.getByRole('menuitem', { name: 'Size of the style' }).click();
    expect(await h.named()).toContainEqual(['fontSize', { fontSize: null }]);
    await expect(button).toHaveAccessibleName('Font size: Size');
  });

  test('the colour and highlight lists offer only values of the model', async ({ page }) => {
    const { h, home } = await openHome(page);
    await focusSurface(page);
    await home.getByRole('button', { name: 'Text colour', exact: true }).click();
    const colours = page.getByRole('menu', { name: 'Text colour' });
    await expect(colours.getByRole('menuitem')).toHaveText([
      'Automatic',
      'Dark red',
      'Dark green',
      'Dark blue',
      'Purple',
      'Dark grey',
    ]);
    await colours.getByRole('menuitem', { name: 'Dark red' }).click();
    expect(await h.named()).toContainEqual(['color', { color: '#A4262C' }]);
    await home.getByRole('button', { name: 'Highlight', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Yellow' }).click();
    expect(await h.named()).toContainEqual(['highlight', { highlight: 'yellow' }]);
    await home.getByRole('button', { name: 'Highlight', exact: true }).click();
    await page.getByRole('menuitem', { name: 'No highlight' }).click();
    expect(await h.named()).toContainEqual(['highlight', { highlight: null }]);
  });

  test('the arrow keys carry focus across the lists and buttons, and the menu keeps its own keys', async ({
    page,
  }) => {
    const { home } = await openHome(page);
    await page.getByRole('tab', { name: 'Home' }).focus();
    await page.keyboard.press('Tab');
    const seen: string[] = [];
    for (let i = 0; i < 30; i++) {
      seen.push((await focused(page)).command ?? '');
      await page.keyboard.press('ArrowRight');
    }
    // Every command of the tab is reached, the lists among them, and the order is the layout's.
    const ids = await home
      .getByRole('button')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-command-id')));
    expect(seen.slice(0, ids.length)).toEqual(ids);
    expect(ids.slice(0, 5)).toEqual([
      'edit.undo',
      'edit.redo',
      'edit.selectAll',
      'format.applyStyle',
      'format.fontSize',
    ]);
    // Inside an open menu the arrows move between its items and do not leave the list.
    await home.locator('button[data-command-id="format.fontSize"]').click();
    await page.keyboard.press('ArrowDown');
    await expect(
      page.getByRole('menu', { name: 'Font size' }).getByRole('menuitemradio').nth(1),
    ).toBeFocused();
    await page.keyboard.press('End');
    await expect(
      page
        .getByRole('menu', { name: 'Font size' })
        .getByRole('menuitem', { name: 'Size of the style' }),
    ).toBeFocused();
    await page.keyboard.press('Home');
    await page.keyboard.press('Escape');
    await expect(home.locator('button[data-command-id="format.fontSize"]')).toBeFocused();
  });

  test('are disabled with their reason for a reader, and the lists do not open', async ({
    page,
  }) => {
    const h = await open(page, {
      toolbar: 'ribbon',
      extended: true,
      paragraphFormat: PARAGRAPH,
      styles: STYLES,
      access: { scope: 'body', caps: ['view'], limit: 'role' },
    });
    const home = page.getByRole('toolbar', { name: 'Home commands' });
    const underline = home.getByRole('button', { name: 'Underline', exact: true });
    await expect(underline).toHaveAttribute('aria-disabled', 'true');
    // Playwright does not click a control that says it is disabled, and a person can: force it.
    await underline.click({ force: true });
    expect(await h.named()).toEqual([]);
    const size = home.locator('button[data-command-id="format.fontSize"]');
    await expect(size).toHaveAttribute('aria-disabled', 'true');
    await size.click({ force: true });
    await expect(page.getByRole('menu')).toHaveCount(0);
  });

  test('has no accessibility violations, with a list open, in light, dark and high contrast', async ({
    page,
  }) => {
    for (const theme of ['light', 'dark', 'high-contrast'] as const) {
      const { home } = await openHome(page, theme);
      expect(await axe(page), `${theme}, closed`).toEqual([]);
      await home.getByRole('button', { name: 'Highlight', exact: true }).click();
      await expect(page.getByRole('menu', { name: 'Highlight' })).toBeVisible();
      expect(await axe(page), `${theme}, highlight open`).toEqual([]);
      await page.keyboard.press('Escape');
      await home.locator('button[data-command-id="format.applyStyle"]').click();
      await expect(page.getByRole('menu', { name: 'Apply style' })).toBeVisible();
      expect(await axe(page), `${theme}, styles open`).toEqual([]);
    }
  });

  test('the compact and the full toolbars show none of them, and exec still runs them', async ({
    page,
  }) => {
    const h = await open(page, {
      toolbar: 'compact',
      extended: true,
      paragraphFormat: PARAGRAPH,
      styles: STYLES,
    });
    const toolbar = page.getByRole('toolbar', { name: 'Editing' });
    const ids = [
      'format.underline',
      'format.align.center',
      'format.bulletList',
      'format.applyStyle',
      'format.fontSize',
      'format.color',
      'format.highlight',
    ];
    for (const id of ids) await expect(toolbar.locator(`[data-command-id="${id}"]`)).toHaveCount(0);
    await expect(page.locator('.de-picker')).toHaveCount(0);
    await h.setSettings({ toolbar: 'full' });
    await expect(page.getByRole('tablist')).toBeVisible();
    for (const id of ids) await expect(page.locator(`[data-command-id="${id}"]`)).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        (window as never as { harness: { exec(id: string): unknown } }).harness.exec(
          'format.underline',
        ),
      ),
    ).toMatchObject({ ran: true });
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
