/**
 * FE-113 criterion 4 (lane V-FE-113-128, round 6): on a touch profile, every visible pointer control
 * of the element's default shell is at least 24 by 24 CSS pixels (the FE-104 criterion 5 minimum,
 * WCAG 2.2 criterion 2.5.8). Measured on the embed page at phone width.
 *
 * Emulation, not devices: the Chromium project uses Playwright's "Pixel 7" profile and the WebKit
 * project uses "iPhone 13". Firefox has no mobile profile in Playwright and is skipped here.
 * Scope: the default shell with the embed page's document, as mounted by mountEditor. Side panes,
 * dialogs and the context menu are not measured on a phone by this file.
 *
 * Run from the repository root with
 * `DOCEDIT_DEMO_PORT=57077 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-113-mobile-target-size.spec.ts --project=chromium --project=webkit --retries=0`.
 */
import { type Browser, type Page, devices, expect, test } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const profiles = {
  chromium: devices['Pixel 7'],
  webkit: devices['iPhone 13'],
} as const;

type Profile = keyof typeof profiles;

function engineOf(projectName: string): Profile | null {
  if (projectName === 'chromium' || projectName === 'webkit') return projectName;
  return null;
}

interface Target {
  label: string;
  width: number;
  height: number;
}

async function withTouch(
  browser: Browser,
  engine: Profile,
  body: (page: Page) => Promise<void>,
): Promise<void> {
  const context = await browser.newContext({ ...profiles[engine] });
  try {
    const page = await context.newPage();
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    await body(page);
  } finally {
    await context.close();
  }
}

test.describe('FE-113 criterion 4: touch controls meet the FE-104 target size', () => {
  // A phone profile mounts the editor slowly on a loaded machine (the mobile spec of criterion 3
  // takes about 30 seconds per test), so the default 60-second limit is raised for this file only.
  test.setTimeout(180_000);

  test('every visible pointer control of the default shell is at least 24 by 24 CSS pixels on a phone profile', async ({
    browser,
  }, testInfo) => {
    const engine = engineOf(testInfo.project.name);
    test.skip(
      engine === null,
      'this file runs in Chromium (Android profile) and WebKit (iPhone profile)',
    );
    await withTouch(browser, engine!, async (page) => {
      const editor = page.locator('doc-editor[data-test="one"]');
      await expect(editor).toBeVisible();
      const targets: Target[] = await page.evaluate(() => {
        const host = document.querySelector('doc-editor[data-test="one"]') as HTMLElement | null;
        const root = host?.shadowRoot;
        if (!root) return [];
        const selector =
          'button, [role="button"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="combobox"], [role="switch"], [role="option"], input, select, a[href]';
        return (
          [...root.querySelectorAll(selector)]
            // Inline targets in the document text (a footnote reference) are not shell controls.
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
  });
});
