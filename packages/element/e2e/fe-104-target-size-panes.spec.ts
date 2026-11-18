/**
 * FE-104 criterion 5, the side panes (lane w1): every pane the embed page's element offers is opened
 * through the command search (Alt+Q), and each visible pointer-operated control of the shell is
 * measured: at least 24 by 24 CSS pixels in its bounding box (WCAG 2.2 criterion 2.5.8; the spacing
 * exception is not used). Controls inside the document's text are left out, as in
 * fe-104-target-size.spec.ts. A pane the embed page's backend does not offer is recorded as not
 * offered, not skipped silently, and the test names the panes it did measure. Handles do not exist
 * (criteria 1 to 4 are not built), so none is measured.
 *
 * Run from the repository root with
 * `DOCEDIT_DEMO_PORT=57175 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-104-target-size-panes.spec.ts --project=chromium --project=firefox --project=webkit`.
 */
import { expect, test, type Page } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';
import { record } from './helpers.ts';

const EDITOR = 'doc-editor[data-test="one"]';

/** The panes of the shell by the name of the command that opens them (strings of the en-GB table). */
const PANES = [
  'Navigation',
  'Comments',
  'Styles',
  'Recovered edits',
  'Keyboard shortcuts',
  'Permissions',
  'Fields to fill',
  'Accessibility checker',
  'Sources',
  'Roles',
  'Field properties',
  'History',
];

const SELECTOR =
  'button, [role="button"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="combobox"], [role="switch"], [role="option"], input, select, a[href]';

interface Small {
  label: string;
  width: number;
  height: number;
}

/** The visible pointer controls of the pane, with those under 24 by 24 CSS pixels. */
function measurePane(page: Page): Promise<{ count: number; small: Small[] }> {
  return page.evaluate(
    ({ selector, editor }) => {
      const pane = document.querySelector(editor)!.shadowRoot!.querySelector('.de-pane');
      if (!pane) return { count: 0, small: [] };
      const found = [...pane.querySelectorAll(selector)]
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
        });
      return { count: found.length, small: found.filter((t) => t.width < 24 || t.height < 24) };
    },
    { selector: SELECTOR, editor: EDITOR },
  );
}

test('FE-104: every pointer control of every offered pane is at least 24 by 24 CSS pixels', async ({
  page,
}) => {
  await openEmbed(page);
  await mountEditor(page, { name: 'one', sub: 'ada' });
  const editor = page.locator(EDITOR);
  await editor.locator('.de-editing-surface').first().click();

  const measured: Record<string, { count: number; small: Small[] }> = {};
  const notOffered: string[] = [];
  for (const name of [...PANES, 'Find', 'Catch up']) {
    await editor.locator('.de-editing-surface').first().focus();
    await page.keyboard.press('Alt+q');
    const search = editor.locator('input[role="combobox"]').first();
    await expect(search).toBeVisible();
    await page.keyboard.type(name);
    await page.waitForTimeout(150);
    const options = editor.locator('[role="option"]');
    const texts = await options.allTextContents();
    const at = texts.findIndex((t) => t.trim().startsWith(name));
    if (at < 0) {
      notOffered.push(name);
      await page.keyboard.press('Escape');
      continue;
    }
    await options.nth(at).hover();
    for (let i = 0; i < at; i++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    const pane = editor.locator('.de-pane').first();
    await expect(pane).toBeVisible();
    await page.waitForTimeout(300);
    measured[name] = await measurePane(page);
    await page.keyboard.press('Escape');
    await expect(editor.locator('.de-pane')).toHaveCount(0);
  }

  record('fe-104-target-size-panes', { measured, notOffered });
  expect(Object.keys(measured).length).toBeGreaterThanOrEqual(3);
  for (const [name, m] of Object.entries(measured)) {
    expect(m.count, `${name} has controls`).toBeGreaterThan(0);
    expect(m.small, `${name}: controls under 24 by 24`).toEqual([]);
  }
});
