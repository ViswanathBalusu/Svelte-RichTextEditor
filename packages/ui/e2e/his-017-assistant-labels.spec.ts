/**
 * Text an assistant wrote for a person, in the history pane (HIS-017 criterion 3): the history
 * list, "who wrote this" and a comparison label it with the person and the agent in words and with
 * an icon, distinct from the person's own writing, and never by colour alone. The icon is hidden
 * from assistive technology; the words carry the meaning.
 * Run from the repository root:
 * `DOCEDIT_UI_PORT=57590 pnpm exec playwright test -c packages/ui/playwright.config.ts his-017`.
 */
import { expect, open, test } from './helpers.ts';

const PANE = '.de-pane[data-pane="history"]';
const LABEL = 'drafting-assistant';

test.describe('assistant-written text in the history pane (HIS-017)', () => {
  test('the history list labels a group with the person and the agent, in words and with an icon', async ({
    page,
  }) => {
    const h = await open(page, { history: 'assisted', features: ['history'], people: 'host' });
    await h.exec('view.history');
    const groups = page.locator(`${PANE} [data-history="group"]`);
    await expect(groups).toHaveCount(2);
    const first = groups.nth(0).locator('[data-assistant]');
    await expect(first).toHaveText(`Written by an assistant for Ada Lovelace: ${LABEL}`);
    const icon = first.locator('svg[data-icon="assistant"]');
    await expect(icon).toHaveAttribute('aria-hidden', 'true');
    // The other group is the people's own writing: no label, no icon.
    await expect(groups.nth(1).locator('[data-assistant]')).toHaveCount(0);
    await expect(groups.nth(1).locator('svg')).toHaveCount(0);
  });

  test('who wrote this tells the assistant line apart from the person own line', async ({
    page,
  }) => {
    const h = await open(page, { history: 'assisted', features: ['history'], people: 'host' });
    await h.exec('view.history');
    await page.locator(`${PANE} [data-history="group"] [data-open-version]`).first().click();
    const view = page.locator(`${PANE} [data-version-view]`);
    await view.locator('[data-who-ask]').click();
    const lines = view.locator('[data-who-answer] li');
    await expect(lines).toHaveCount(4);
    const assisted = view.locator('[data-who-answer] li:has([data-assistant])');
    await expect(assisted).toHaveCount(1);
    await expect(assisted).toContainText('Ada Lovelace: 1 passage');
    await expect(assisted).toContainText(`Written by an assistant (${LABEL}) for this person.`);
    await expect(assisted.locator('svg[data-icon="assistant"]')).toHaveCount(1);
    // Ada's own line is a separate line without the label.
    const own = view.locator('[data-who-answer] li', { hasText: 'Ada Lovelace: 2 passages' });
    await expect(own).toHaveCount(1);
    await expect(own.locator('[data-assistant]')).toHaveCount(0);
    // Not by colour: every line has the colour of the list, and the label is text.
    const colours = await lines.evaluateAll((els) => els.map((el) => getComputedStyle(el).color));
    expect(new Set(colours).size).toBe(1);
  });

  test('a comparison lists the assistant change in words with an icon and announces it', async ({
    page,
    browserName,
  }) => {
    const h = await open(page, { history: 'assisted', features: ['history'], people: 'host' });
    await h.exec('view.history');
    const pane = page.locator(PANE);
    await pane.locator('[data-compare-run]').click();
    const view = pane.locator('[data-version-view]');
    await expect(view.locator('[data-compare]')).toBeVisible();
    const row = view.locator('[data-compare-assistant] li');
    await expect(row).toHaveCount(1);
    await expect(row).toHaveText(
      `Change 3: text changed, written by an assistant (${LABEL}) for Ada Lovelace`,
    );
    await expect(row.locator('svg[data-icon="assistant"]')).toHaveAttribute('aria-hidden', 'true');
    // The live region says it too when the reader moves to that change.
    const announce = view.locator('[data-compare-announce]');
    const next = view.getByRole('button', { name: 'Next change' });
    await next.focus();
    for (let i = 0; i < 3; i++) await page.keyboard.press('Enter');
    await expect(announce).toHaveText(
      `Change 3 of 5: text changed, written by an assistant (${LABEL}) for Ada Lovelace`,
    );
    expect(browserName).toBeTruthy();
  });

  test('the person own writing is never labelled as an assistant', async ({ page }) => {
    const h = await open(page, { history: 'versions', features: ['history'], people: 'host' });
    await h.exec('view.history');
    const pane = page.locator(PANE);
    await expect(pane.locator('[data-assistant]')).toHaveCount(0);
    await pane.locator('[data-compare-run]').click();
    await expect(pane.locator('[data-compare]')).toBeVisible();
    await expect(pane.locator('[data-compare-assistant]')).toHaveCount(0);
    await expect(pane.locator('[data-assistant]')).toHaveCount(0);
  });
});
