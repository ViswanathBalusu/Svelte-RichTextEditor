/**
 * FE-108 criterion 4, the control for fe-108-axe-idrefs.spec.ts (lane V-FE-097-112, fixer round 1).
 * axe-core reports an `aria-labelledby` or `aria-describedby` whose ID it cannot find as "needs
 * review" (`results.incomplete`, message `noIdShadow` inside a shadow tree), not as a violation. This
 * file proves that the check of that spec (no node listed by `aria-valid-attr-value` or
 * `aria-valid-attr` under `violations` or under `incomplete`) goes red when a reference in the shadow
 * root does not resolve, and runs the same check on one more state (the regions document with the
 * full toolbar).
 *
 * Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts e2e/fe-108-axe-idrefs-control.spec.ts --project=chromium --project=firefox --project=webkit --output <scratch dir>`.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const RULES = ['aria-valid-attr-value', 'aria-valid-attr'];

interface Listed {
  id: string;
  targets: string[];
}

function listed(results: { id: string; nodes: { target: unknown[] }[] }[]): Listed[] {
  return results
    .filter((r) => RULES.includes(r.id))
    .map((r) => ({ id: r.id, targets: r.nodes.map((n) => n.target.map(String).join(' ')) }))
    .filter((r) => r.targets.length > 0);
}

/** The same reading as fe-108-axe-idrefs.spec.ts: violations and "needs review" for the rules. */
async function check(page: Page): Promise<{ violations: Listed[]; incomplete: Listed[] }> {
  const results = await new AxeBuilder({ page })
    .include('doc-editor[data-test="one"]')
    .withRules(RULES)
    .analyze();
  return { violations: listed(results.violations), incomplete: listed(results.incomplete) };
}

test.describe('the axe reference check can fail (FE-108, criterion 4)', () => {
  test('a broken aria-labelledby in the shadow root is listed, so the check goes red', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada', attributes: { toolbar: 'full' } });
    const before = await check(page);
    expect([...before.violations, ...before.incomplete]).toEqual([]);
    const injected = await page.evaluate(() => {
      const root = document.querySelector('doc-editor[data-test="one"]')!.shadowRoot!;
      const target = root.querySelector('button');
      if (!target) return null;
      target.setAttribute('aria-labelledby', 'fe-108-does-not-exist');
      return target.outerHTML.slice(0, 80);
    });
    expect(injected).not.toBeNull();
    const after = await check(page);
    const flagged = [...after.violations, ...after.incomplete].filter(
      (r) => r.id === 'aria-valid-attr-value',
    );
    // The check of fe-108-axe-idrefs.spec.ts expects both lists to be empty: here they are not.
    expect(flagged.flatMap((r) => r.targets).length).toBe(1);
  });

  test('a broken aria-describedby in the shadow root is listed as well', async ({ page }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    await page.evaluate(() => {
      const root = document.querySelector('doc-editor[data-test="one"]')!.shadowRoot!;
      root.querySelector('.de-editing-surface')!.setAttribute('aria-describedby', 'fe-108-gone');
    });
    const after = await check(page);
    const flagged = [...after.violations, ...after.incomplete].filter(
      (r) => r.id === 'aria-valid-attr-value',
    );
    expect(flagged.flatMap((r) => r.targets).length).toBeGreaterThan(0);
  });

  test('the editor over the regions document, with the toolbar, has no unresolved reference', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, {
      name: 'one',
      sub: 'ada',
      doc: 'regions',
      attributes: { toolbar: 'full' },
    });
    const result = await check(page);
    expect(result.violations).toEqual([]);
    expect(result.incomplete).toEqual([]);
  });
});
