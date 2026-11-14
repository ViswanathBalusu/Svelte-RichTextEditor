/**
 * FE-047 criterion 6 (lane U-FE-033-048): when "all" covers a scope where the user lacks `edit`, the
 * suggestions there are skipped and the number skipped is reported to the person, in the shell's
 * live region.
 *
 * Runs through the embed page with the in-memory backend. `bob` joins as a suggester, so the body
 * has `suggest` only: he may record a suggestion, but not accept or reject one (rule P4). He types
 * in the body, which records an `ins` he authored; accepting all in the document then skips it, and
 * the notice names the count. Run with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-047-skipped-notice.spec.ts --project=chromium`.
 */
import { expect, test } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const editor = (name = 'one') => `doc-editor[data-test="${name}"]`;

interface Report {
  handled: number;
  skipped: number;
  skippedScopes: string[];
}

test.describe('FE-047 criterion 6: skipped suggestions are reported', () => {
  test('accept all by a suggester skips the body and the notice names the number', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'bob', role: 'suggester' });

    await page.locator(`${editor()} .de-editing-surface p`, { hasText: 'Last paragraph.' }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Typed');

    const report: Report = await page.evaluate(async (sel) => {
      const e = (
        window as unknown as {
          __embed: {
            internals(el: Element): {
              editor: {
                core: {
                  resolveSuggestions(action: string, target: string): Report;
                };
              } | null;
            };
          };
        }
      ).__embed;
      const el = document.querySelector(sel)!;
      return e.internals(el).editor!.core.resolveSuggestions('accept', 'document');
    }, editor());

    expect(report.handled).toBe(0);
    expect(report.skipped).toBeGreaterThan(0);
    expect(report.skippedScopes).toContain('body');

    // The notice names the same number, in the shell's live region (the shadow root of the element).
    await expect
      .poll(() =>
        page.evaluate(
          (sel) =>
            [...document.querySelector(sel)!.shadowRoot!.querySelectorAll('[role="status"]')]
              .map((el) => el.textContent?.trim() ?? '')
              .join(' | '),
          editor(),
        ),
      )
      .toContain(`Not handled: ${report.skipped} suggestion(s)`);
  });
});
