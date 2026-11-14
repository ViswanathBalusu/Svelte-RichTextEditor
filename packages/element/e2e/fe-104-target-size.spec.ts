/**
 * FE-104 criteria 5 and 6 (lane V-FE-097-112): pointer-operated controls are at least 24 by 24 CSS
 * pixels (WCAG 2.2 criterion 2.5.8, the minimum; the spacing exception is not used here), and no
 * sticky or fixed bar covers the caret while it moves through the page. Measured on the S1 page in
 * the element's shadow root, with the default shell. Run from the repository root with
 * `DOCEDIT_DEMO_PORT=57063 pnpm exec playwright test -c packages/element/playwright.config.ts e2e/fe-104-target-size.spec.ts --project=chromium --project=firefox --project=webkit`.
 */
import { expect, test } from '@playwright/test';
import { openS1 } from './helpers.ts';

interface Target {
  label: string;
  width: number;
  height: number;
}

test.describe('pointer targets and sticky bars (FE-104)', () => {
  test('every visible pointer control of the default shell is at least 24 by 24 CSS pixels', async ({
    page,
  }) => {
    await openS1(page);
    const targets: Target[] = await page.evaluate(() => {
      const root = document.querySelector('doc-editor')!.shadowRoot!;
      const selector =
        'button, [role="button"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="combobox"], [role="switch"], [role="option"], input, select, a[href]';
      return (
        [...root.querySelectorAll(selector)]
          // Inline targets in the document's text (a footnote reference) are not controls of the
          // shell: WCAG 2.2 criterion 2.5.8 exempts a target in a sentence, so they are left out.
          .filter((el) => !el.closest('.de-editing-surface, .de-sub-editor'))
          .filter((el) => {
            const style = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return (
              style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              rect.width > 0 &&
              rect.height > 0
            );
          })
          .map((el) => {
            const rect = el.getBoundingClientRect();
            const label =
              el.getAttribute('aria-label') ??
              el.getAttribute('title') ??
              el.textContent?.trim() ??
              el.tagName;
            return {
              label: `${el.tagName.toLowerCase()} ${label.slice(0, 40)}`,
              width: rect.width,
              height: rect.height,
            };
          })
      );
    });
    expect(targets.length).toBeGreaterThan(0);
    const small = targets.filter((t) => t.width < 24 || t.height < 24);
    expect(small).toEqual([]);
  });

  test('no sticky or fixed element of the shell covers the editing surface', async ({ page }) => {
    await openS1(page);
    const bars = await page.evaluate(() => {
      const root = document.querySelector('doc-editor')!.shadowRoot!;
      return [...root.querySelectorAll('*')]
        .filter((el) => {
          const position = getComputedStyle(el).position;
          return position === 'sticky' || position === 'fixed';
        })
        .map((el) => el.className || el.tagName.toLowerCase());
    });
    // The shell has no sticky or fixed bar: the toolbar and the status bar take their place in the
    // flow, so a caret that moves into the page is never under one of them.
    expect(bars).toEqual([]);
  });
});
