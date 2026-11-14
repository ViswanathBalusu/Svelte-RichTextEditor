/**
 * PRO-084 criteria 2 and 3 on the mounted element (lane V-PRO-069-085): `getSelectionContent()`
 * returns the selected block as a CDM fragment, and `insertContent(fragment)` at the caret inserts it
 * through the same guards as typing and reports `ok`. The rules are the engine's (FE-027); this run
 * checks the element's own methods in a browser, on the embed page's in-memory backend.
 *
 * Run from the repository root with
 * `DOCEDIT_DEMO_PORT=57130 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/pro-084-selection-insert.spec.ts --project=chromium --project=firefox --project=webkit`.
 */
import { expect, test, type Page } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const editor = 'doc-editor[data-test="one"]';
const surface = (page: Page) => page.locator(`${editor} .de-editing-surface`);
/** Whether the core's selection is collapsed: `getSelectionContent()` holds no nodes. */
const collapsed = (page: Page) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement & {
      getSelectionContent(): { content: unknown[] } | null;
    };
    return el.getSelectionContent()?.content.length === 0;
  }, editor);

test.describe('PRO-084 the host reads the selection and inserts a fragment', () => {
  test('getSelectionContent returns the selected block, and insertContent at the caret inserts it', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });

    // Select the last paragraph and read it as a CDM fragment through the element.
    await surface(page).locator('p', { hasText: 'Last paragraph.' }).click();
    await page.keyboard.press('End');
    // Fifteen characters back: the length of "Last paragraph.".
    for (let i = 0; i < 'Last paragraph.'.length; i++) await page.keyboard.press('Shift+ArrowLeft');
    // The core takes the DOM selection on its own schedule, so the read is polled.
    const readFragment = () =>
      page.evaluate((sel) => {
        const el = document.querySelector(sel) as HTMLElement & {
          getSelectionContent(): {
            cdm: number;
            content: Array<{ content?: Array<{ text?: string }> }>;
          } | null;
        };
        const frag = el.getSelectionContent();
        // Kept in the page: the caret moves before the insertion.
        (window as unknown as { __pro084Fragment: unknown }).__pro084Fragment = frag;
        return frag;
      }, editor);
    await expect
      .poll(async () => JSON.stringify(await readFragment()))
      .toContain('Last paragraph.');
    const fragment = await readFragment();
    expect(fragment).not.toBeNull();
    expect(fragment!.cdm).toBe(1);
    // The selection is inline text inside one paragraph, so the fragment's nodes are text nodes.
    const text = (fragment!.content ?? [])
      .map(
        (n) => (n as { text?: string }).text ?? (n.content ?? []).map((c) => c.text ?? '').join(''),
      )
      .join('\n');
    expect(text).toContain('Last paragraph.');

    // Put the caret at the start of the first paragraph and insert the fragment there.
    await surface(page).locator('p').first().click();
    await page.keyboard.press('Home');
    // The core takes the new caret on `selectionchange`, which Chromium dispatches in a later task.
    // Until then its selection is still "Last paragraph.", and the insertion would replace that text
    // with itself. Wait until the core's selection is collapsed (an empty fragment).
    await expect.poll(() => collapsed(page)).toBe(true);
    const outcome = await page.evaluate(async (sel) => {
      const el = document.querySelector(sel) as HTMLElement & {
        getSelectionContent(): unknown;
        insertContent(f: unknown): { ok: boolean; reason?: string };
      };
      const frag = (window as unknown as { __pro084Fragment: unknown }).__pro084Fragment;
      return el.insertContent(frag);
    }, editor);
    expect(outcome.ok).toBe(true);

    // The inserted block is in the visible document: the text now appears twice.
    await expect
      .poll(async () => (await surface(page).textContent())!.split('Last paragraph.').length - 1)
      .toBe(2);
  });
});
