/**
 * FE-041 criterion 1 (lane U-FE-033-048): a suggester who has `suggest` but not `edit` in the scope at
 * the caret sees suggestion mode on, and the mode control lists `edit` disabled with its reason.
 *
 * Runs through the embed page (`pages/embed.html`) with the in-memory backend: `bob` joins with the
 * `suggester` role, so the body has `suggest` only. Run with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-041-suggester-mode.spec.ts --project=chromium`.
 */
import { expect, test } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const editor = (name = 'one') => `doc-editor[data-test="${name}"]`;

test.describe('FE-041 suggestion mode for a suggest-only user', () => {
  test('the mode control offers edit disabled, with the reason, and suggestion mode is on', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'bob', role: 'suggester' });

    const modeButton = page.locator(`${editor()} .de-mode-button`);
    await expect(modeButton).toBeVisible();
    await modeButton.click();

    const edit = page.locator(`${editor()} [role="menuitemradio"][data-command-id="mode.edit"]`);
    await expect(edit).toHaveAttribute('aria-disabled', 'true');
    const reasonId = await edit.getAttribute('aria-describedby');
    expect(reasonId).not.toBeNull();
    const reason = page.locator(`${editor()} #${reasonId}`);
    await expect(reason).not.toHaveText('');

    // Choosing the disabled item changes nothing: the mode stays the one the rules give.
    await edit.click({ force: true });
    await expect(page.locator(`${editor()} .de-mode-button`)).not.toHaveAttribute(
      'data-mode',
      'edit',
    );

    // The core's read-only view reports suggestion mode on, and locked, with the reason `rights`.
    const suggestion = await page.evaluate((sel) => {
      const e = (
        window as unknown as {
          __embed: {
            internals(el: Element): { editor: { core: { suggestion: { get(): unknown } } } | null };
          };
        }
      ).__embed;
      const core = e.internals(document.querySelector(sel)!).editor!.core as unknown as {
        suggestion: { get(): { on: boolean; reason: string | null } };
      };
      return core.suggestion.get();
    }, editor());
    expect(suggestion).toMatchObject({ on: true, reason: 'rights' });
  });
});
