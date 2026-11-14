/**
 * FE-108 criterion 4 (lane V-FE-097-112): when axe runs on the editor, it finds no unresolved ARIA
 * reference. axe pierces the shadow root, so its `aria-valid-attr-value` rule (the ID references of
 * `aria-labelledby`, `aria-describedby`, `aria-controls`, `aria-owns` and `aria-activedescendant`)
 * and `aria-valid-attr` are run on the default editor and on the editor with the toolbar and the
 * status bar. The same states are checked for every reference in the root by fe-108-aria-refs.spec.ts
 * (criterion 1, the states it reaches). Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts e2e/fe-108-axe-idrefs.spec.ts --project=chromium --project=firefox --project=webkit --output <scratch dir>`.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const RULES = ['aria-valid-attr-value', 'aria-valid-attr'];

interface Check {
  violations: { id: string; targets: string[] }[];
  /**
   * Nodes axe could not decide on (for example an ID reference whose target is not in the root,
   * which axe reports as "needs review" inside a shadow tree, not as a violation).
   */
  incomplete: { id: string; targets: string[] }[];
  /** Nodes axe found the ID references on and passed (so the rule ran on references). */
  referencesPassed: number;
}

async function unresolved(page: Page): Promise<Check> {
  const results = await new AxeBuilder({ page })
    .include('doc-editor[data-test="one"]')
    .withRules(RULES)
    .analyze();
  const passed = results.passes.find((p) => p.id === 'aria-valid-attr-value');
  return {
    violations: results.violations.map((v) => ({
      id: v.id,
      targets: v.nodes.map((n) => n.target.map(String).join(' ')),
    })),
    incomplete: results.incomplete.map((v) => ({
      id: v.id,
      targets: v.nodes.map((n) => n.target.map(String).join(' ')),
    })),
    referencesPassed: passed ? passed.nodes.length : 0,
  };
}

test.describe('axe finds no unresolved ARIA reference (FE-108, criterion 4)', () => {
  test('the default editor has no unresolved reference under axe', async ({ page }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    await expect(page.locator('doc-editor[data-test="one"] .de-editing-surface')).toBeVisible();
    const check = await unresolved(page);
    expect(check.violations).toEqual([]);
    expect(check.incomplete).toEqual([]);
    expect(check.referencesPassed).toBeGreaterThan(0);
  });

  test('the editor with the toolbar and the status bar has no unresolved reference under axe', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada', attributes: { toolbar: 'full' } });
    await expect(page.locator('doc-editor[data-test="one"] .de-editing-surface')).toBeVisible();
    const check = await unresolved(page);
    expect(check.violations).toEqual([]);
    expect(check.incomplete).toEqual([]);
    expect(check.referencesPassed).toBeGreaterThan(0);
  });
});
