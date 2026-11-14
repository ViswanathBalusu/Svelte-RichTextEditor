/**
 * The status bar as the host sees it (UX-018, criterion 6; lane U-UX-016-030). The bar exposes the
 * `statusbar` part, which the host page can style through `::part(statusbar)`, and the extension
 * items (UX-052) appear in it at their edges. The classification label (UX-085) is covered by
 * classification.spec.ts. Run from the repository root with
 * `pnpm exec playwright test -c packages/ui/playwright.config.ts ux-018-statusbar`.
 */
import { expect, open, test } from './helpers.ts';

test.describe('the status bar part and extension items (UX-018)', () => {
  test('the host can style the statusbar part, and the extension items sit at the two edges', async ({
    page,
  }) => {
    await open(page, { extended: true, extensionContributions: true });
    const bar = page.locator('.de-status');
    await expect(bar).toHaveAttribute('part', 'statusbar');
    // A host rule written in the host page reaches the part through ::part().
    // The strict policy forbids inline style elements, so the host rule is added through CSSOM.
    await page.evaluate(() => {
      const sheet = new CSSStyleSheet();
      sheet.insertRule('#host::part(statusbar) { outline: 3px solid rgb(1, 2, 3); }');
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    });
    const outline = await bar.evaluate((el) => getComputedStyle(el).outlineColor);
    expect(outline).toBe('rgb(1, 2, 3)');

    const start = bar.locator('[data-status-item="ext.start-status"][data-position="start"]');
    const end = bar.locator('[data-status-item="ext.end-status"][data-position="end"]');
    // The item's text is in the bar; its visually hidden label follows it in textContent.
    await expect(start).toContainText('Extension start');
    await expect(end).toContainText('Extension end');
    await expect(start).toBeVisible();
    await expect(end).toBeVisible();
    // The start item comes before the end item in the bar (the start group, then the end group).
    const before = await start.evaluate((el) => {
      const other = el.parentElement!.querySelector('[data-position="end"]');
      return (
        other !== null &&
        Boolean(el.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING)
      );
    });
    expect(before).toBe(true);
  });
});
