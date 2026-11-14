/**
 * FE-029 criterion 3 (lane V-FE-017-032): `mode="review"` set before the element connects turns
 * suggestion mode on when the document loads (FE-041), and the server's permissions still apply: a
 * suggester who has `suggest` but not `edit` keeps the reason `rights` on the suggestion view.
 * Read through the core's `suggestion` view, as fe-041-suggester-mode.spec.ts does. Runs in every
 * project of the element's Playwright config.
 *
 * Run from the repository root with
 *   pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-029-review-mode.spec.ts --retries=0 --output=packages/element/test-results/V-FE-017-032-fe029
 */
import { expect, test, type Page } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const editor = 'doc-editor[data-test="one"]';

const suggestion = (page: Page) =>
  page.evaluate((sel) => {
    const e = (
      window as unknown as {
        __embed: {
          internals(el: Element): {
            editor: {
              core: { suggestion: { get(): { on: boolean; reason: string | null } } };
            } | null;
          };
        };
      }
    ).__embed;
    return e.internals(document.querySelector(sel)!).editor!.core.suggestion.get();
  }, editor);

test.describe('FE-029 criterion 3: review mode turns suggestion mode on', () => {
  test('an editor who opens in review mode gets suggestion mode on, and the surface stays editable', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada', mode: 'review' });
    await expect(page.locator(`${editor} .de-editing-surface`)).toHaveAttribute(
      'contenteditable',
      'true',
    );
    expect(await suggestion(page)).toMatchObject({ on: true });
  });

  test('a suggester who opens in review mode keeps the rights reason, so the permissions still apply', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'bob', role: 'suggester', mode: 'review' });
    await expect(page.locator(`${editor} .de-editing-surface`)).toHaveAttribute(
      'contenteditable',
      'true',
    );
    expect(await suggestion(page)).toMatchObject({ on: true, reason: 'rights' });
  });
});
