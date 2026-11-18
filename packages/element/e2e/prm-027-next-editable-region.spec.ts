/**
 * PRM-027 criteria 1 and 4 in the real `<doc-editor>` (lane w9): the command that moves the caret
 * to the next region the user may edit is declared by the element (`nextEditableRegion` in
 * `commandNames`) and answered by the core (`hasNextEditableRegion`), so `navigate.nextEditableRegion`
 * is registered in the full toolbar, operable from the keyboard, and enabled only while a later
 * region may be edited. The document is the embed page's region document: a paragraph, the open
 * region Middle, a paragraph, the open region End and a trailing paragraph.
 *
 * The embed page with the in-memory backend (`pages/embed.html`). Run with `DOCEDIT_DEMO_PORT=56552
 * pnpm exec playwright test -c packages/element/playwright.config.ts
 * packages/element/e2e/prm-027-next-editable-region.spec.ts --project=chromium`.
 */
import { type Page, expect, test } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const IDS = {
  before: 'pBefore000000001',
  first: 'pRegionFirst0001',
  endText: 'pEndText00000001',
  trailing: 'pTrailing0000001',
} as const;

const editor = 'doc-editor[data-test="one"]';

/** Calls a method of the spike harness of the editor on the page. */
function call<T>(page: Page, name: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    async ({ name, args }) => {
      const e = (
        window as unknown as {
          __embed: { harness(el: Element): Promise<Record<string, (...a: unknown[]) => unknown>> };
        }
      ).__embed;
      const h = await e.harness(document.querySelector('doc-editor[data-test="one"]')!);
      return h[name]!(...args) as T;
    },
    { name, args },
  );
}

const caretIn = (page: Page, id: string) => call<unknown>(page, 'caretIn', id, 'start');
const head = async (page: Page) => (await call<{ from: number }>(page, 'selection')).from;

function command(page: Page) {
  return page.locator(
    `${editor} [role="tabpanel"] [data-command-id="navigate.nextEditableRegion"]`,
  );
}

test.describe('PRM-027: the next part I can edit, in <doc-editor>', () => {
  test('is registered in the toolbar, runs from the keyboard and follows the caret', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, {
      sub: 'ada',
      role: 'owner',
      doc: 'regions',
      attributes: { toolbar: 'full' },
    });

    // Where the caret lands: the first text position of each region.
    await caretIn(page, IDS.first);
    const middle = await head(page);
    await caretIn(page, IDS.endText);
    const end = await head(page);
    expect(end).toBeGreaterThan(middle);

    await page.locator(editor).getByRole('tab', { name: 'Review' }).click();
    const button = command(page);
    await expect(button).toHaveCount(1);

    // From the first paragraph the next region is Middle, then End, then there is none.
    await caretIn(page, IDS.before);
    await expect(button).not.toHaveAttribute('aria-disabled', 'true');
    await button.focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => head(page)).toBe(middle);

    await expect(button).not.toHaveAttribute('aria-disabled', 'true');
    await button.focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => head(page)).toBe(end);

    // The caret is in the last region: nothing after it may be edited.
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await caretIn(page, IDS.trailing);
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await caretIn(page, IDS.before);
    await expect(button).not.toHaveAttribute('aria-disabled', 'true');
  });
});
