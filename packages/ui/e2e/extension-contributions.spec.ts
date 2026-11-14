/**
 * An extension's panel and status-bar items in the shell (UX-052). The harness contributes a panel
 * through `contributePanel` and one status item at each edge of the status bar
 * (`extensionContributions`). Run from the repository root with
 * `pnpm exec playwright test -c packages/ui/playwright.config.ts extension-contributions.spec.ts`.
 */
import { axe, expect, focused, focusSurface, open, test } from './helpers.ts';

test.describe('extension panels and status-bar items (UX-052)', () => {
  test('a contributed panel opens on demand, takes focus and is reached by Ctrl+F6', async ({
    page,
  }) => {
    const h = await open(page, { extensionContributions: true });
    await focusSurface(page);
    expect(await h.openExtensionPane()).toBe(true);
    const pane = page.locator('.de-pane[data-pane="ext-notes"]');
    await expect(pane).toBeVisible();
    await expect(pane.locator('.de-pane-title')).toHaveText('Extension notes');
    await expect(pane.locator('[data-extension-pane]')).toHaveAttribute('data-ready', 'true');
    // Opening moves focus into the panel's content, as a built-in pane does.
    expect((await focused(page)).inside).toBe('pane');
    // Focus leaves the panel and comes back to it by the landmark keys.
    await page.keyboard.press('Escape');
    await expect(pane).toHaveCount(0);
    await focusSurface(page);
    expect(await h.openExtensionPane()).toBe(true);
    await expect(pane).toBeVisible();
    const order: string[] = [];
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Control+F6');
      order.push((await focused(page)).inside ?? '');
      if (order.at(-1) === 'pane') break;
    }
    expect(order).toContain('pane');
    expect(await axe(page)).toEqual([]);
  });

  test('the status bar shows a start item before the scope and an end item after the zoom', async ({
    page,
  }) => {
    await open(page, { extensionContributions: true });
    const bar = page.locator('.de-status');
    const start = bar.locator('[data-status-item="ext.start-status"]');
    const end = bar.locator('[data-status-item="ext.end-status"]');
    await expect(start).toHaveAttribute('data-position', 'start');
    await expect(end).toHaveAttribute('data-position', 'end');
    // The text alternative is read by assistive technology; the visible text is hidden from it.
    await expect(start.locator('.de-visually-hidden')).toHaveText('Extension start status');
    await expect(start.locator('[aria-hidden="true"]')).toHaveText('Extension start');
    await expect(end.locator('.de-visually-hidden')).toHaveText('Extension end status');
    const order = await bar.evaluate((node) => {
      const kids = [
        ...node.querySelectorAll('[data-status="extension"], [data-status="scope"], .de-zoom'),
      ];
      return kids.map(
        (k) => k.getAttribute('data-status-item') ?? k.getAttribute('data-status') ?? 'zoom',
      );
    });
    expect(order).toEqual(['ext.start-status', 'scope', 'zoom', 'ext.end-status']);
    expect(await axe(page)).toEqual([]);
  });
});
