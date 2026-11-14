/**
 * FE-019 criterion 4 (lane U-FE-017-032): under the Playwright `forcedColors: "active"` emulation,
 * axe reports no violation that the same page does not already report without it. The check
 * compares the rule ids and the node counts of two axe runs on the mounted editor (the shadow root
 * is included by axe). Run in Chromium (see the story's evidence).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

type Summary = Map<string, number>;

async function summarise(page: Page): Promise<Summary> {
  const results = await new AxeBuilder({ page }).analyze();
  const summary: Summary = new Map();
  for (const v of results.violations) summary.set(v.id, v.nodes.length);
  return summary;
}

test.describe('FE-019 forced colours: axe finds nothing new', () => {
  test('forcedColors active adds no axe violation to the mounted editor', async ({ page }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    await expect(page.locator('doc-editor[data-test="one"] .de-editing-surface')).toHaveAttribute(
      'contenteditable',
      'true',
    );

    const normal = await summarise(page);
    await page.emulateMedia({ forcedColors: 'active' });
    await expect
      .poll(() => page.evaluate(() => matchMedia('(forced-colors: active)').matches))
      .toBe(true);
    const forced = await summarise(page);

    const added = [...forced.keys()].filter((id) => !normal.has(id));
    const grew = [...forced.keys()].filter(
      (id) => normal.has(id) && forced.get(id)! > normal.get(id)!,
    );
    expect({ added, grew }).toEqual({ added: [], grew: [] });
  });
});
