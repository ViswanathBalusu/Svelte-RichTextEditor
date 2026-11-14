/**
 * FE-020 criterion 1, dialogs (lane V-FE-017-032). The command search of the shell (Alt+Q, the
 * `view.commandSearch` command) is an overlay with `role="dialog"`. It lives inside the element's
 * shadow root, nothing is appended to the host page's body or head, and Escape closes it with
 * focus back in the editing surface. Runs in every project of the element's Playwright config.
 *
 * Not covered here: the native `Dialog.svelte` dialogs (language, region, export, comment). On the
 * embed page their commands are not enabled, so the command search lists none of them (checked
 * 2026-11-14 in Chromium), and no run opened one. Tooltips are native `title` attributes, which the
 * browser draws outside the DOM, so there is no element to inspect.
 *
 * Run from the repository root with
 *   pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-020-dialog-shadow.spec.ts --retries=0 --output=packages/element/test-results/V-FE-017-032-fe020
 */
import { expect, test, type Page } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const editor = 'doc-editor[data-test="one"]';
const search = '[role="dialog"][aria-label="Search commands"]';

const hostCounts = (page: Page) =>
  page.evaluate(() => ({
    body: document.body.childElementCount,
    head: document.head.childElementCount,
    lightDialogs: document.querySelectorAll('[role="dialog"]').length,
  }));

test.describe('FE-020 criterion 1: an overlay dialog lives in the shadow root', () => {
  test('the command search is in the shadow root, nothing is appended to the host page, Escape closes it', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    const surface = page.locator(`${editor} .de-editing-surface`);
    await expect(surface).toHaveAttribute('contenteditable', 'true');

    const before = await hostCounts(page);
    await surface.click();
    await page.keyboard.press('Alt+q');

    const placed = await page.evaluate(
      ({ sel, dialogSel }) => {
        const host = document.querySelector(sel) as HTMLElement;
        const found = host.shadowRoot?.querySelectorAll(dialogSel) ?? [];
        return {
          inShadow: found.length,
          inLightDom: document.querySelectorAll(dialogSel).length,
        };
      },
      { sel: editor, dialogSel: search },
    );
    expect(placed).toEqual({ inShadow: 1, inLightDom: 0 });

    // FE-020 criterion 5 (the labelled control and its overlay): every ID reference inside the
    // overlay resolves in the shadow root, and at least one does (so the check is not empty).
    const refs = await page.evaluate(
      ({ sel, dialogSel }) => {
        const host = document.querySelector(sel) as HTMLElement;
        const root = host.shadowRoot!;
        const dialog = root.querySelector(dialogSel)!;
        const lists = ['aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns'];
        const singles = ['aria-activedescendant'];
        let resolved = 0;
        const unresolved: string[] = [];
        for (const el of [dialog, ...dialog.querySelectorAll('*')]) {
          for (const attr of lists) {
            for (const id of (el.getAttribute(attr) ?? '').split(/\s+/).filter(Boolean)) {
              if (root.getElementById(id)) resolved += 1;
              else unresolved.push(`${el.tagName}.${attr}=${id}`);
            }
          }
          for (const attr of singles) {
            const id = el.getAttribute(attr);
            if (!id) continue;
            if (root.getElementById(id)) resolved += 1;
            else unresolved.push(`${attr}=${id}`);
          }
        }
        return { resolved, unresolved };
      },
      { sel: editor, dialogSel: search },
    );
    expect(refs.unresolved).toEqual([]);
    expect(refs.resolved).toBeGreaterThan(0);

    const after = await hostCounts(page);
    expect(after.body).toBe(before.body);
    expect(after.head).toBe(before.head);
    expect(after.lightDialogs).toBe(0);

    await page.keyboard.press('Escape');
    await expect(page.locator(`${editor}`).locator(search)).toBeHidden();
    await expect
      .poll(() =>
        page.evaluate(
          (sel) =>
            (
              document.querySelector(sel) as HTMLElement
            ).shadowRoot?.activeElement?.classList.contains('de-editing-surface') ?? false,
          editor,
        ),
      )
      .toBe(true);
  });
});
