/**
 * UX-018 criterion 6 (lane V-UX-016-030): the status bar exposes the `statusbar` part, and the
 * extension items (UX-052) and the classification label (UX-085) appear in it when present. Rendered
 * in Chromium, Firefox and WebKit: the part is on the bar element itself, and each item is a
 * descendant of that bar. Run from the repository root with
 * `pnpm exec playwright test -c packages/ui/playwright.config.ts ux-018-statusbar-parts`.
 */
import { expect, open, test } from './helpers.ts';

test.describe('status bar part and its items (UX-018 criterion 6)', () => {
  test('the bar exposes the statusbar part and holds the extension items and the classification label', async ({
    page,
  }) => {
    await open(page, {
      extensionContributions: true,
      classification: { name: 'Internal use only' },
    });
    const bar = page.locator('.de-status[part="statusbar"]');
    await expect(bar).toHaveCount(1);
    await expect(
      bar.locator('[data-status="extension"][data-status-item="ext.start-status"]'),
    ).toHaveCount(1);
    await expect(
      bar.locator('[data-status="extension"][data-status-item="ext.end-status"]'),
    ).toHaveCount(1);
    await expect(bar.locator('[data-status="classification"]')).toHaveText(
      'Classification: Internal use only',
    );
    // The extension item at the start edge sits before the classification label in the bar's order.
    const order = await bar.evaluate((el) => {
      const ids = [...el.querySelectorAll('[data-status]')].map(
        (x) => x.getAttribute('data-status-item') ?? x.getAttribute('data-status'),
      );
      return ids;
    });
    expect(order.indexOf('ext.start-status')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('ext.start-status')).toBeLessThan(order.indexOf('classification'));
  });

  test('without a classification label, the bar still shows its extension items and no classification item', async ({
    page,
  }) => {
    await open(page, { extensionContributions: true, classification: null });
    const bar = page.locator('.de-status[part="statusbar"]');
    await expect(bar.locator('[data-status="extension"]')).toHaveCount(2);
    await expect(bar.locator('[data-status="classification"]')).toHaveCount(0);
  });
});
