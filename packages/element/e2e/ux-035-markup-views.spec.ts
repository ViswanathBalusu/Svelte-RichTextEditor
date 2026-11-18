/**
 * The markup views in the production element (UX-035). The real element runs with its demo backend.
 * The registry's `review.markup.*` commands choose the view of the engine core, the choice is a
 * setting that sends no commit (the document's revision does not move), and the shell has given
 * the core the words that name a suggestion for assistive technology. How each view is drawn is
 * checked in packages/engine/src/view/ux-035-markup-view.universal.test.ts. Run with
 * `DOCEDIT_DEMO_PORT=57331 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/ux-035-markup-views.spec.ts --project=<browser>`.
 */
import { expect, test } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const EDITOR = 'doc-editor[data-test="one"]';

interface MarkupCore {
  markupView: { get(): string };
  revision: { get(): number };
  suggestionLabel: ((kind: 'ins' | 'del' | 'fmt', user: string) => string) | null;
}

test.describe('markup views in the element (UX-035)', () => {
  test('the commands choose the core view without a commit, and the core has words for suggestions', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page);
    const outcome = await page.evaluate((sel) => {
      const el = document.querySelector(sel) as unknown as { exec(name: string): boolean };
      const hooks = (globalThis as unknown as { __embed: { internals(el: Element): unknown } })
        .__embed;
      const core = (
        hooks.internals(document.querySelector(sel)!) as { editor: { core: MarkupCore } }
      ).editor.core;
      const revision = core.revision.get();
      const views = [core.markupView.get()];
      const ran: boolean[] = [];
      for (const view of ['simple', 'none', 'original', 'all']) {
        ran.push(el.exec(`review.markup.${view}`));
        views.push(core.markupView.get());
      }
      return {
        views,
        ran,
        revisionKept: core.revision.get() === revision,
        words: core.suggestionLabel?.('ins', 'someone') ?? null,
      };
    }, EDITOR);
    expect(outcome.ran).toEqual([true, true, true, true]);
    expect(outcome.views).toEqual(['all', 'simple', 'none', 'original', 'all']);
    expect(outcome.revisionKept).toBe(true);
    expect(outcome.words).toMatch(/^Inserted by /);
  });

  test('a suggestion typed in review mode is drawn per view, and its words are in the accessibility tree', async ({
    page,
    browserName,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { mode: 'review' });
    const surface = page.locator(`${EDITOR} .de-editing-surface`);
    await surface.locator('p', { hasText: 'Last paragraph.' }).click();
    await page.keyboard.press('End');
    await page.keyboard.type('ZZ');
    const ins = surface.locator('.de-suggest-ins');
    await expect(ins).toHaveCount(1);
    await expect(ins).toHaveText('ZZ');

    // The words a screen reader hears, before the insertion, with the neutral name of the author.
    const words = await ins.evaluate((el) => getComputedStyle(el, '::before').content);
    expect(words).toContain('Inserted by ');

    // criterion 4: the words are in the browser's accessibility tree (Chromium's, through the
    // protocol; the other browsers have no such hook in Playwright), and the kind is a line, not colour.
    if (browserName === 'chromium') {
      const cdp = await page.context().newCDPSession(page);
      const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as {
        nodes: Array<{ role?: { value?: string }; name?: { value?: string } }>;
      };
      const heard = nodes.filter((n) => (n.name?.value ?? '').includes('Inserted by '));
      expect(heard.length).toBeGreaterThan(0);
    }
    expect(await ins.evaluate((el) => getComputedStyle(el).textDecorationLine)).toContain(
      'underline',
    );

    // The views: simple bars it, none draws nothing, original hides it, all draws it again.
    await page.evaluate((sel) => {
      (document.querySelector(sel) as unknown as { exec(name: string): boolean }).exec(
        'review.markup.simple',
      );
    }, EDITOR);
    await expect(surface.locator('.de-suggest-changed')).toHaveText('ZZ');
    await page.evaluate((sel) => {
      (document.querySelector(sel) as unknown as { exec(name: string): boolean }).exec(
        'review.markup.original',
      );
    }, EDITOR);
    await expect(surface.locator('[data-suggestion-id]').first()).toBeHidden();
    await page.evaluate((sel) => {
      (document.querySelector(sel) as unknown as { exec(name: string): boolean }).exec(
        'review.markup.none',
      );
    }, EDITOR);
    await expect(
      surface.locator('.de-suggest-ins, .de-suggest-changed, .de-suggest-hidden'),
    ).toHaveCount(0);
    await expect(surface).toContainText('ZZ');
  });
});
