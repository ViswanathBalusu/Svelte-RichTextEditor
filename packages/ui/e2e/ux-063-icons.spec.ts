/**
 * Host icons in the shell (UX-063, criteria 1 and 3). The host's drawing for a command's icon name
 * appears in the toolbar and the menus, a name the host leaves out or draws badly keeps the
 * built-in drawing, a name nobody draws shows no glyph, a drawing is never markup, and the
 * control's accessible name stays its label.
 */
import type { Page } from '@playwright/test';
import { expect, open, test } from './helpers.ts';

const SQUARE = 'M4 4h16v16H4z';
const HOST = 'M3 3h18v18H3z';

/** The `d` of each path in the icon drawn on a toolbar control, or null when none is drawn. */
async function drawn(page: Page, command: string): Promise<string[] | null> {
  return page.evaluate((id: string) => {
    const root = document.getElementById('host')!.shadowRoot!;
    const control = root.querySelector(`.de-toolbar [data-command-id="${id}"]`);
    const svg = control?.querySelector('svg.de-icon');
    return svg ? [...svg.querySelectorAll('path')].map((p) => p.getAttribute('d') ?? '') : null;
  }, command);
}

const BOLD = 'format.bold';
const ITALIC = 'format.italic';

test.describe('host icons in the shell (UX-063, criteria 1 and 3)', () => {
  test('the toolbar draws the built-in icon of a command that has one, once the host gives a set', async ({
    page,
  }) => {
    await open(page, { icons: {} });
    const paths = await drawn(page, BOLD);
    expect(paths).not.toBeNull();
    expect(paths!.length).toBeGreaterThan(0);
  });

  test('without a set from the host, the toolbar and the menus show labels only', async ({
    page,
  }) => {
    const h = await open(page, { extended: true });
    expect(await drawn(page, BOLD)).toBeNull();
    await page
      .locator('.de-editing-surface')
      .click({ button: 'right', position: { x: 30, y: 10 } });
    await expect(page.getByRole('menu', { name: 'Commands for the selection' })).toBeVisible();
    const icons = await page.evaluate(
      () => document.getElementById('host')!.shadowRoot!.querySelectorAll('svg.de-icon').length,
    );
    expect(icons).toBe(0);
    // Giving a set shows them; taking it away removes them again.
    await h.setIcons({});
    await expect.poll(() => drawn(page, BOLD)).not.toBeNull();
    await h.setIcons(null);
    await expect.poll(() => drawn(page, BOLD)).toBeNull();
  });

  test('a host icon replaces the built-in one for its name only', async ({ page }) => {
    const h = await open(page, { icons: {} });
    const before = await drawn(page, ITALIC);
    await h.setIcons({ bold: SQUARE });
    await expect.poll(() => drawn(page, BOLD)).toEqual([SQUARE]);
    expect(await drawn(page, ITALIC)).toEqual(before);
  });

  test('the host icon is there from the first render, and as a drawing with its own grid', async ({
    page,
  }) => {
    await open(page, { icons: { bold: { paths: [HOST], viewBox: '0 0 48 48', fill: true } } });
    expect(await drawn(page, BOLD)).toEqual([HOST]);
    const svg = await page.evaluate(() => {
      const el = document
        .getElementById('host')!
        .shadowRoot!.querySelector('.de-toolbar [data-command-id="format.bold"] svg.de-icon')!;
      return { viewBox: el.getAttribute('viewBox'), fill: el.classList.contains('de-icon-fill') };
    });
    expect(svg).toEqual({ viewBox: '0 0 48 48', fill: true });
  });

  test('an icon that is not path data falls back to the built-in one, with no broken glyph', async ({
    page,
  }) => {
    await open(page, { icons: {} });
    const builtIn = await drawn(page, BOLD);
    const h = await open(page, { icons: { bold: '<svg onload="x()"></svg>', italic: 42 } });
    expect(await drawn(page, BOLD)).toEqual(builtIn);
    expect(await h.iconsInvalid()).toEqual(['bold', 'italic']);
    const broken = await page.evaluate(
      () =>
        document
          .getElementById('host')!
          .shadowRoot!.querySelectorAll('svg.de-icon:not(:has(path)), svg.de-icon path[d=""]')
          .length,
    );
    expect(broken).toBe(0);
  });

  test('a command whose icon name nobody draws shows its label and no glyph', async ({ page }) => {
    await open(page, { icons: {} });
    const result = await page.evaluate(() => {
      const root = document.getElementById('host')!.shadowRoot!;
      const buttons = [...root.querySelectorAll('.de-toolbar button.de-tool')];
      const bare = buttons.filter((b) => !b.querySelector('svg') && b.textContent!.trim() !== '');
      return { count: buttons.length, bare: bare.length };
    });
    expect(result.count).toBeGreaterThan(0);
    expect(result.bare).toBeGreaterThan(0);
  });

  test('a host value is drawn as path data and never inserted as markup', async ({ page }) => {
    await open(page, {
      icons: {
        bold: '<img src=x onerror="window.__icon=1">',
        italic: { paths: ['<script>window.__icon=1</script>'] },
      },
    });
    const result = await page.evaluate(() => {
      const root = document.getElementById('host')!.shadowRoot!;
      return {
        images: root.querySelectorAll('img').length,
        scripts: root.querySelectorAll('script').length,
        ran: (window as unknown as { __icon?: number }).__icon ?? 0,
      };
    });
    expect(result).toEqual({ images: 0, scripts: 0, ran: 0 });
  });

  test('the accessible name stays the label, with a built-in or a host icon', async ({ page }) => {
    const h = await open(page, { icons: {} });
    const control = page.getByRole('button', { name: 'Bold', exact: true });
    await expect(control).toHaveAccessibleName('Bold');
    await h.setIcons({ bold: SQUARE });
    await expect.poll(() => drawn(page, BOLD)).toEqual([SQUARE]);
    await expect(control).toHaveAccessibleName('Bold');
    // The icon is hidden from assistive technology and carries no name of its own.
    const icon = await page.evaluate(() => {
      const svg = document
        .getElementById('host')!
        .shadowRoot!.querySelector('.de-toolbar [data-command-id="format.bold"] svg.de-icon')!;
      return {
        hidden: svg.getAttribute('aria-hidden'),
        focusable: svg.getAttribute('focusable'),
        title: svg.querySelectorAll('title, desc').length,
        label: svg.getAttribute('aria-label'),
        text: svg.textContent,
      };
    });
    expect(icon).toEqual({ hidden: 'true', focusable: 'false', title: 0, label: null, text: '' });
  });

  test('the accessible name does not change when the label is replaced and the icon is too', async ({
    page,
  }) => {
    await open(page, { icons: { bold: SQUARE }, overrides: { 'command.format.bold': 'Strong' } });
    await expect(page.getByRole('button', { name: 'Strong', exact: true })).toHaveAccessibleName(
      'Strong',
    );
    expect(await drawn(page, BOLD)).toEqual([SQUARE]);
  });

  test('the context menu draws the host icon beside the label, and keeps its name', async ({
    page,
  }) => {
    await open(page, { extended: true, icons: { bold: SQUARE } });
    await page
      .locator('.de-editing-surface')
      .click({ button: 'right', position: { x: 30, y: 10 } });
    const menu = page.getByRole('menu', { name: 'Commands for the selection' });
    await expect(menu).toBeVisible();
    const items = await menu.locator('[data-menu-item]').evaluateAll((els) =>
      els.map((el) => ({
        id: el.getAttribute('data-command-id'),
        paths: [...el.querySelectorAll('svg.de-icon path')].map((p) => p.getAttribute('d')),
      })),
    );
    const bold = items.find((i) => i.id === BOLD);
    expect(bold?.paths).toEqual([SQUARE]);
    const drawnAny = items.filter((i) => i.paths.length > 0).length;
    expect(drawnAny).toBeGreaterThan(0);
    const named = menu.locator(`[data-command-id="${BOLD}"]`);
    await expect(named).toHaveAccessibleName(/^Bold/);
  });
});
