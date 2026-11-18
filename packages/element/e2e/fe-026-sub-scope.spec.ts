/**
 * FE-026 criterion 3 (lane V-FE-017-032): `selectionScope()` reports the scope of the selection,
 * including a story when a header's sub-editor holds the caret. The element's core is read through
 * the test hook `__embed.internals(el)`; the header is opened with the `editHeader` command (the
 * same command the shell's Header button runs). Runs in every project of the element's config.
 *
 * Run from the repository root with
 *   pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-026-sub-scope.spec.ts --retries=0 --output=packages/element/test-results/V-FE-017-032-fe026-scope
 */
import { expect, test, type Page } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const editor = 'doc-editor[data-test="one"]';

interface ScopeRead {
  scope: string;
  blockId: string | null;
}

/** The core's selectionScope() as the element's core reports it (the test hook, not an API). */
function readScope(page: Page): Promise<ScopeRead> {
  return page.evaluate((sel) => {
    const hooks = (globalThis as unknown as { __embed: { internals(el: Element): unknown } })
      .__embed;
    const el = document.querySelector(sel)!;
    const internals = hooks.internals(el) as {
      editor: { core: { selectionScope(): ScopeRead } };
    };
    return internals.editor.core.selectionScope();
  }, editor);
}

test.describe('FE-026 criterion 3: selectionScope() reports the story of a focused header', () => {
  test('a header sub-editor with focus gives its story scope; the body gives body', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    const surface = page.locator(`${editor} .de-editing-surface`);
    await expect(surface).toHaveAttribute('contenteditable', 'true');

    // The body first: a caret in a body paragraph is in the body.
    await surface.locator('p', { hasText: 'Last paragraph.' }).click();
    const inBody = await readScope(page);
    expect(inBody.scope).toBe('body');
    expect(inBody.blockId).not.toBeNull();

    // Open the header; its sub-editor takes the focus.
    const ran = await page.evaluate((sel) => {
      const el = document.querySelector(sel) as unknown as {
        exec(name: string): { ok: boolean };
      };
      return el.exec('editHeader').ok;
    }, editor);
    expect(ran).toBe(true);
    // The header's sub-editor holds the caret once it is focused: the scope is its story.
    await expect.poll(async () => (await readScope(page)).scope.startsWith('story:')).toBe(true);
    const inHeader = await readScope(page);
    expect(inHeader.blockId).not.toBeNull();

    // Back to the body: the body's caret counts again.
    await surface.locator('p', { hasText: 'Last paragraph.' }).click();
    await expect.poll(async () => (await readScope(page)).scope).toBe('body');
  });
});
