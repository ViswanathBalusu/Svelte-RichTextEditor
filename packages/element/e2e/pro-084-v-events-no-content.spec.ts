/**
 * PRO-084 criterion 5 on the mounted element (lane V-PRO-069-085): when the host reads content with
 * `getContent()` and `getSelectionContent()`, or inserts it with `insertContent()`, no event the
 * element raises carries document content. The page's recorder (`__embed.events`, e2e/embed-helpers.ts)
 * keeps every `de-*` event that reaches the document; the test serialises each detail and checks that
 * none contains the text the host read or inserted.
 *
 * Run from the repository root with
 * `DOCEDIT_DEMO_PORT=57130 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/pro-084-v-events-no-content.spec.ts --project=chromium --project=firefox --project=webkit`.
 */
import { expect, test, type Page } from '@playwright/test';
import { events, mountEditor, openEmbed } from './embed-helpers.ts';

const editor = 'doc-editor[data-test="one"]';
const surface = (page: Page) => page.locator(`${editor} .de-editing-surface`);
const SECRET_TEXT = 'Last paragraph.';
/** The core's selection as `getSelectionContent()` returns it, serialised. */
const selectionJson = (page: Page) =>
  page.evaluate(
    (sel) =>
      JSON.stringify(
        (
          document.querySelector(sel) as HTMLElement & { getSelectionContent(): unknown }
        ).getSelectionContent() ?? { content: [null] },
      ),
    editor,
  );

test.describe('PRO-084 criterion 5: content calls raise no content in events', () => {
  test('no de-* event detail carries the text read or inserted by getContent, getSelectionContent or insertContent', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });

    // Select the last paragraph, as the sibling test does, then read the content and the selection.
    await surface(page).locator('p', { hasText: SECRET_TEXT }).click();
    await page.keyboard.press('End');
    for (let i = 0; i < SECRET_TEXT.length; i++) await page.keyboard.press('Shift+ArrowLeft');
    // The core takes the DOM selection on `selectionchange`, which Chromium dispatches in a later
    // task: wait until its selection holds the whole text before reading it.
    await expect.poll(() => selectionJson(page)).toContain(SECRET_TEXT);

    const read = await page.evaluate(async (sel) => {
      const el = document.querySelector(sel) as HTMLElement & {
        getContent(): Promise<unknown>;
        getSelectionContent(): unknown;
      };
      const content = await el.getContent();
      const fragment = el.getSelectionContent();
      // Kept in the page: moving the caret for the insertion clears the selection.
      (window as unknown as { __pro084Fragment: unknown }).__pro084Fragment = fragment;
      return { hasContent: content !== null, hasFragment: fragment !== null };
    }, editor);
    expect(read.hasContent).toBe(true);
    expect(read.hasFragment).toBe(true);

    // Insert the block read above at the start of the first paragraph, through the element.
    await surface(page).locator('p').first().click();
    await page.keyboard.press('Home');
    // Until the core takes the new caret, its selection is still the last paragraph, and the
    // insertion would replace that text with itself. Wait for a collapsed selection (no nodes).
    await expect.poll(async () => JSON.parse(await selectionJson(page)).content.length).toBe(0);
    const outcome = await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement & {
        insertContent(f: unknown): { ok: boolean };
      };
      const fragment = (window as unknown as { __pro084Fragment: unknown }).__pro084Fragment;
      return el.insertContent(fragment);
    }, editor);
    expect(outcome.ok).toBe(true);
    await expect
      .poll(async () => (await surface(page).textContent())!.split(SECRET_TEXT).length - 1)
      .toBe(2);

    // Let the confirmed change and any status events reach the page before the scan.
    await expect.poll(async () => (await events(page, 'de-ready')).length).toBeGreaterThan(0);
    await page.waitForTimeout(1500);

    const recorded = await events(page);
    const names = new Set(recorded.map((e) => e.name));
    expect(names.has('de-ready'), 'the session raised de-ready').toBe(true);
    for (const event of recorded) {
      if (!event.name.startsWith('de-')) continue;
      const serialised = JSON.stringify(event.detail ?? null);
      expect(serialised, `${event.name} detail carries document text`).not.toContain(SECRET_TEXT);
    }
  });
});
