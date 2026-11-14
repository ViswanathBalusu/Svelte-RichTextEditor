/**
 * FE-044 criterion 5 in the real `<doc-editor>` (lane U-FE-033-048, fix round 8): a block command
 * suggestion mode cannot record (here `markRegion`, behind the toolbar's `insert.region`) is
 * unavailable in suggestion mode, and its reason is shown. The element forwards the core's
 * `canMarkRegion` and `queryReason` to the shell and declares `markRegion` (src/editor.ts), so the
 * entry is registered; the reason is the core's `suggestion`, shown as `reason.query.suggestion`.
 *
 * The embed page with the in-memory backend (`pages/embed.html`). Run with `DOCEDIT_DEMO_PORT=56551
 * pnpm exec playwright test -c packages/element/playwright.config.ts
 * packages/element/e2e/fe-044-region-suggestion-reason.spec.ts`.
 */
import { expect, test, type Page } from '@playwright/test';
import { SPIKE_IDS } from '@docedit/engine/spike-document';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const editor = 'doc-editor[data-test="one"]';
const REASON =
  'Suggestion mode records changes as suggestions, and this change cannot be recorded as one, so it is not made.';

interface Doc {
  type?: string;
  content?: Doc[];
}

async function caretAtEnd(page: Page): Promise<void> {
  await page.evaluate(
    async ({ sel, node }) => {
      const el = document.querySelector(sel)!;
      const h = await (
        window as unknown as {
          __embed: { harness(el: Element): Promise<{ caretIn(id: string, at: 'end'): void }> };
        }
      ).__embed.harness(el);
      h.caretIn(node, 'end');
    },
    { sel: editor, node: SPIKE_IDS.last },
  );
}

function regionCount(page: Page): Promise<number> {
  return page.evaluate(async (sel) => {
    const el = document.querySelector(sel)!;
    const h = await (
      window as unknown as { __embed: { harness(el: Element): Promise<{ doc(): unknown }> } }
    ).__embed.harness(el);
    let n = 0;
    const walk = (d: { type?: string; content?: unknown[] }): void => {
      if (d.type === 'region') n++;
      for (const c of d.content ?? []) walk(c as { type?: string; content?: unknown[] });
    };
    walk(h.doc() as Doc);
    return n;
  }, editor);
}

function regionButton(page: Page) {
  return page.locator(`${editor} [role="tabpanel"] [data-command-id="insert.region"]`);
}

async function openInsertTab(page: Page): Promise<void> {
  await page.locator(editor).getByRole('tab', { name: 'Insert' }).click();
}

test.describe('FE-044 criterion 5: marking a region is unavailable in suggestion mode, with the reason', () => {
  test('mode="review": insert.region is disabled and describes the suggestion reason; activating it changes nothing', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, {
      sub: 'ada',
      role: 'owner',
      mode: 'review',
      attributes: { toolbar: 'full' },
    });
    await caretAtEnd(page);
    await openInsertTab(page);
    const button = regionButton(page);
    await expect(button).toHaveCount(1);
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(button).toHaveAccessibleDescription(REASON);
    await expect(button).toHaveAttribute('title', REASON);

    const before = await regionCount(page);
    // An aria-disabled control stays focusable; Enter runs it through the registry, which refuses it
    // and announces the reason.
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator(`${editor} [role="status"]`).filter({ hasText: REASON })).toHaveCount(
      1,
    );
    await expect(page.locator(editor).getByRole('dialog', { name: 'Make a region' })).toHaveCount(
      0,
    );
    expect(await regionCount(page)).toBe(before);
  });

  test('mode="edit" for the same owner: insert.region is enabled and has no reason', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, {
      sub: 'ada',
      role: 'owner',
      mode: 'edit',
      attributes: { toolbar: 'full' },
    });
    await caretAtEnd(page);
    await openInsertTab(page);
    const button = regionButton(page);
    await expect(button).toHaveCount(1);
    await expect(button).not.toHaveAttribute('aria-disabled', 'true');
    await expect(button).not.toHaveAttribute('title', REASON);
  });
});
