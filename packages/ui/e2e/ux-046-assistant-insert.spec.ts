/**
 * Approving an assistant result in the pane (UX-046 criteria 1 and 4; lane w3). The pane hands the
 * shown result to the core's insertion, which records it as suggestions; the pane inserts nothing
 * itself. Where the core refuses, nothing is applied, the author is told and the result stays shown.
 * A view-only author has the insertion disabled with its reason. The core is the harness's fake and
 * records what it was asked to insert; the real core is exercised in
 * packages/element/e2e/ux-045-assistant-pane.spec.ts and packages/engine/test/ux-046-assistant-insert.test.ts.
 * Run with `DOCEDIT_UI_PORT=57271 pnpm exec playwright test -c packages/ui/playwright.config.ts
 * packages/ui/e2e/ux-046-assistant-insert.spec.ts --project=<browser>`.
 */
import { expect, open, test } from './helpers.ts';

const PANE = '.de-pane[data-pane="assistant"]';
const EDITOR = { scope: 'body', caps: ['view', 'comment', 'suggest', 'edit'] } as const;
const VIEWER = { scope: 'body', caps: ['view'] } as const;

test.describe('approving an assistant result (UX-046)', () => {
  test('nothing is inserted until the author approves, and then the core is asked once', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, assistant: true, access: EDITOR });
    await h.exec('view.assistant');
    const pane = page.locator(PANE);
    await pane.getByRole('textbox').fill('Draft it');
    await pane.locator('[data-ask="draft"]').click();
    await expect(pane.locator('[data-assistant-state="shown"]')).toBeVisible();
    expect(await h.assistantInserted()).toEqual([]);
    await pane.locator('[data-assistant-insert]').click();
    await expect(pane.locator('[data-assistant-state="inserted"]')).toContainText('as suggestions');
    await expect(pane.locator('[data-assistant-live]')).toHaveText(/inserted as suggestions/);
    expect(await h.assistantInserted()).toEqual(['Answer to: Draft it']);
  });

  test('a refusal by the core applies nothing, tells the author and keeps the result', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, assistant: true, access: EDITOR });
    await h.exec('view.assistant');
    await h.setAssistantInsertRefusal('no-suggest');
    const pane = page.locator(PANE);
    await pane.locator('[data-ask="draft"]').click();
    await expect(pane.locator('[data-assistant-state="shown"]')).toBeVisible();
    await pane.locator('[data-assistant-insert]').click();
    await expect(pane.locator('[data-assistant-insert-refused]')).toContainText(
      'Nothing was applied',
    );
    await expect(pane.locator('[data-assistant-state="shown"]')).toBeVisible();
    expect(await h.assistantInserted()).toEqual([]);
    // The author can try again once the region allows it.
    await h.setAssistantInsertRefusal(null);
    await pane.locator('[data-assistant-insert]').click();
    await expect(pane.locator('[data-assistant-state="inserted"]')).toBeVisible();
    expect(await h.assistantInserted()).toHaveLength(1);
  });

  test('a view-only author sees the insertion disabled with its reason and nothing is inserted', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, assistant: true, access: VIEWER });
    await h.exec('view.assistant');
    const pane = page.locator(PANE);
    await pane.locator('[data-ask="question"]').click();
    const insert = pane.locator('[data-assistant-insert]');
    await expect(insert).toHaveAttribute('aria-disabled', 'true');
    await expect(insert).toHaveAccessibleDescription(/does not allow/);
    await insert.click({ force: true });
    expect(await h.assistantInserted()).toEqual([]);
    await expect(pane.locator('[data-assistant-state="shown"]')).toBeVisible();
  });
});
