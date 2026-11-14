/**
 * The interface mirrors in a right-to-left locale (UX-065, criteria 1 and 3; lane U-UX-061-075).
 *
 * Criterion 1: the header, the toolbar's tabs, the status bar and a pane are placed from the other
 * side in `ar-XB` (the right-to-left pseudo-locale) than in `en-GB`. The test reads the computed
 * direction of the shell and compares the centres of the elements with the centres of their
 * containers. Nothing in the shell was changed for this: the stylesheet already uses logical
 * properties only (UX-064, test/logical-css.test.ts).
 *
 * Criterion 3: the arrow keys of the full toolbar's tab list move to the next tab in the reading
 * direction, so ArrowLeft in `ar-XB` and ArrowRight in `en-GB`.
 *
 * Not covered here: criterion 2 (direction-carrying icons, which needs metadata in the icon set; the
 * icon set in packages/ui/src has none), and criterion 5 (collaborators' carets, whose coordinates
 * are physical in src/components/Carets.svelte).
 *
 * Run with `DOCEDIT_UI_PORT=56293 pnpm exec playwright test -c packages/ui/playwright.config.ts ux-065-rtl-layout`.
 */
import type { Page } from '@playwright/test';
import { expect, open, test } from './helpers.ts';

const STYLES = [{ id: 'Normal', name: 'Normal', kind: 'paragraph' as const }];

/** Centres along the horizontal axis of the shell, and the computed direction of the shell. */
async function layout(page: Page) {
  return page.evaluate(() => {
    const root = document.getElementById('host')!.shadowRoot!;
    const centre = (el: Element | null): number => {
      if (!el) return Number.NaN;
      const r = el.getBoundingClientRect();
      return r.left + r.width / 2;
    };
    const q = (selector: string) => root.querySelector(selector);
    const tabs = [...root.querySelectorAll('[role="tab"]')];
    // The first status item with a box is the one at the start of the bar (the bar is a flex row).
    const startItem =
      [...root.querySelectorAll('.de-status > *')].find(
        (el) => el.getBoundingClientRect().width > 0,
      ) ?? null;
    return {
      direction: getComputedStyle(q('.de-shell')!).direction,
      headerTitle: centre(q('.de-header-title')),
      header: centre(q('.de-header')),
      firstTab: centre(tabs[0] ?? null),
      tablist: centre(q('.de-tabs')),
      statusStart: centre(startItem),
      status: centre(q('.de-status')),
      pane: centre(q('.de-pane[data-pane="styles"]')),
      page: centre(q('.de-page')),
    };
  });
}

test.describe('the interface mirrors in a right-to-left locale (UX-065, criterion 1)', () => {
  test('header, toolbar tabs, status bar and panes are placed from the other side in ar-XB', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, toolbar: 'full', styles: STYLES });
    expect(await h.exec('view.styles')).toEqual({ ran: true, reason: null });
    await expect(page.locator('.de-pane[data-pane="styles"]')).toBeVisible();

    const ltr = await layout(page);
    expect(ltr.direction).toBe('ltr');
    expect(ltr.headerTitle).toBeLessThan(ltr.header);
    expect(ltr.firstTab).toBeLessThan(ltr.tablist);
    expect(ltr.statusStart).toBeLessThan(ltr.status);
    expect(ltr.pane).toBeGreaterThan(ltr.page);

    await h.setLocale('ar-XB');
    await expect(page.locator('.de-shell')).toHaveAttribute('dir', 'rtl');
    await h.frames(2);

    const rtl = await layout(page);
    expect(rtl.direction).toBe('rtl');
    expect(rtl.headerTitle).toBeGreaterThan(rtl.header);
    expect(rtl.firstTab).toBeGreaterThan(rtl.tablist);
    expect(rtl.statusStart).toBeGreaterThan(rtl.status);
    expect(rtl.pane).toBeLessThan(rtl.page);
  });
});

test.describe('the arrow keys follow the reading direction (UX-065, criterion 3)', () => {
  /** The tab groups in order, after focusing the first tab and pressing Home (the first group becomes active). */
  async function focusFirstTab(page: Page): Promise<string[]> {
    const groups = await page.evaluate(() => {
      const root = document.getElementById('host')!.shadowRoot!;
      const tabs = [...root.querySelectorAll<HTMLElement>('[role="tab"]')];
      tabs[0]!.focus();
      return tabs.map((t) => t.dataset['group'] ?? '');
    });
    await page.keyboard.press('Home');
    return groups;
  }

  /** The group of the selected tab, which is the one the toolbar's keys move from. */
  async function selectedGroup(page: Page): Promise<string | null> {
    return page.evaluate(
      () =>
        document
          .getElementById('host')!
          .shadowRoot!.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.dataset[
          'group'
        ] ?? null,
    );
  }

  test('ArrowRight moves to the next tab in en-GB, and ArrowLeft in ar-XB', async ({ page }) => {
    const h = await open(page, { extended: true, toolbar: 'full', styles: STYLES });

    const ltr = await focusFirstTab(page);
    expect(await selectedGroup(page)).toBe(ltr[0]);
    await page.keyboard.press('ArrowRight');
    expect(await selectedGroup(page)).toBe(ltr[1]);

    await h.setLocale('ar-XB');
    await expect(page.locator('.de-shell')).toHaveAttribute('dir', 'rtl');
    await h.frames(2);

    const rtl = await focusFirstTab(page);
    expect(await selectedGroup(page)).toBe(rtl[0]);
    await page.keyboard.press('ArrowLeft');
    expect(await selectedGroup(page)).toBe(rtl[1]);
    await page.keyboard.press('ArrowRight');
    expect(await selectedGroup(page)).toBe(rtl[0]);
  });
});
