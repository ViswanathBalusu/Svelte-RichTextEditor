/**
 * The rule builder alone (FRW-024), in the browser: the rules as sentences, a rule built from a
 * condition and effects, a rule opened and saved without change, the refusals with the keys they
 * name, the limit of 500 rules, the read-only state, keyboard use with visible focus, and axe. Run with
 * `DOCEDIT_UI_PORT=57434 pnpm exec playwright test -c packages/ui/playwright.config.ts packages/ui/e2e/frw-024-rule-builder.spec.ts`.
 * The core's part (the rules as definitions, the compile, the limit and the guard) is in
 * packages/engine/test/frw-024.rule-edit.test.ts; here the harness only records what would reach it.
 */
import { expect, test, type Page } from '@playwright/test';
import { axe } from './helpers.ts';

interface Recorded {
  saves: Array<{ id: string; replace?: string; parts: Record<string, unknown> }>;
  removes: string[];
  shown: string[];
}

function recorded(page: Page): Promise<Recorded> {
  return page.evaluate(() => (window as unknown as { harness: Recorded }).harness);
}

const SPOUSE_SENTENCE =
  'If tenant.maritalStatus is married, show tenant.spouseName and require tenant.spouseName; otherwise hide tenant.spouseName.';

// Playwright's Firefox on Windows crashes the page while axe runs over a form that shows an alert (the
// field properties panel of FRW-073 does the same). The same form without the alert passes in Firefox.
const FIREFOX_AXE_ALERT = 'Playwright Firefox on Windows crashes in axe over a visible alert';

test.describe('FRW-024 rule builder', () => {
  test('lists a rule as a sentence and shows a rule of another shape as stored, unchangeable', async ({
    page,
  }) => {
    await page.goto('/rule-builder.html');
    await expect(page.getByText(SPOUSE_SENTENCE, { exact: true })).toBeVisible();
    await expect(page.getByText('This rule is not in sentence form')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Change rule r_other' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Change rule r_spouse' })).toBeEnabled();
  });

  test('builds a rule from a condition and effects, shows its sentence and saves it', async ({
    page,
  }) => {
    await page.goto('/rule-builder.html');
    await page.getByRole('button', { name: 'Add a rule' }).click();
    await page.getByLabel('Left side: Field', { exact: true }).selectOption('tenant.amount');
    await page.getByLabel('Comparison', { exact: true }).selectOption('>=');
    await page.getByLabel('Right side: Value', { exact: true }).fill('10');
    await page.getByLabel('Effect 1', { exact: true }).selectOption('require');
    await page.getByLabel('Field of the effect 1', { exact: true }).selectOption('lease.total');
    await page.getByLabel('Add an otherwise').check();
    await page.getByLabel('Effect 1', { exact: true }).last().selectOption('hide');
    await page
      .getByLabel('Field of the effect 1', { exact: true })
      .last()
      .selectOption('lease.total');
    await expect(page.locator('.de-rule-preview')).toContainText(
      'If tenant.amount is at least 10, require lease.total; otherwise hide lease.total.',
    );
    await page.getByRole('button', { name: 'Save the rule' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'The rule was saved.' })).toBeVisible();
    await expect(
      page.getByText(
        'If tenant.amount is at least 10, require lease.total; otherwise hide lease.total.',
        {
          exact: true,
        },
      ),
    ).toBeVisible();
    const { saves } = await recorded(page);
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({
      id: 'rule_3',
      parts: {
        left: { field: 'tenant.amount' },
        operator: '>=',
        right: { literal: '10' },
        then: [{ effect: 'require', keys: ['lease.total'] }],
        otherwise: [{ effect: 'hide', keys: ['lease.total'] }],
      },
    });
  });

  test('refuses a form with nothing chosen, in a live region, and sends nothing', async ({
    page,
  }) => {
    await page.goto('/rule-builder.html');
    await page.getByRole('button', { name: 'Add a rule' }).click();
    await page.getByLabel('Left side: Field', { exact: true }).selectOption('');
    await page.getByRole('button', { name: 'Save the rule' }).click();
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('Choose the left side of the comparison.');
    await expect(alert).toContainText('Give the right side of the comparison.');
    await expect(page.getByLabel('Left side: Field', { exact: true })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect((await recorded(page)).saves).toEqual([]);
  });

  test('a rule opened and saved without change sends nothing and says so', async ({ page }) => {
    await page.goto('/rule-builder.html');
    await page.getByRole('button', { name: 'Change rule r_spouse' }).click();
    await page.getByRole('button', { name: 'Save the rule' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Nothing has changed.' }),
    ).toBeVisible();
    expect((await recorded(page)).saves).toEqual([]);
  });

  test('a changed rule is sent with the name of the rule it replaces', async ({ page }) => {
    await page.goto('/rule-builder.html');
    await page.getByRole('button', { name: 'Change rule r_spouse' }).click();
    await page.getByLabel('Right side: Value', { exact: true }).fill('single');
    await page.getByRole('button', { name: 'Save the rule' }).click();
    await expect(
      page.getByText(SPOUSE_SENTENCE.replace('married', 'single'), { exact: true }),
    ).toBeVisible();
    const { saves } = await recorded(page);
    expect(saves[0]).toMatchObject({ id: 'r_spouse', replace: 'r_spouse' });
  });

  test('a refusal names the keys, each a button that moves to the field', async ({ page }) => {
    await page.goto('/rule-builder.html?bad=1');
    await page.getByRole('button', { name: 'Add a rule' }).click();
    await page.getByLabel('Left side: Field', { exact: true }).selectOption('tenant.amount');
    await page.getByLabel('Right side: Value', { exact: true }).fill('1');
    await page.getByLabel('Field of the effect 1', { exact: true }).selectOption('lease.total');
    await page.getByRole('button', { name: 'Save the rule' }).click();
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('The document would not be valid with this rule:');
    await expect(alert).toContainText('A rule names a field that cannot be used.');
    await alert.getByRole('button', { name: 'Go to field lease.total' }).click();
    expect((await recorded(page)).shown).toEqual(['lease.total']);
  });

  // Playwright's Firefox on Windows crashes the page when anything is done after axe has run on a
  // page with form controls (the field properties panel does the same), so each axe run ends its test.
  test('axe finds no violation in a refusal that names keys', async ({ page, browserName }) => {
    test.skip(browserName === 'firefox', FIREFOX_AXE_ALERT);
    await page.goto('/rule-builder.html?bad=1');
    await page.getByRole('button', { name: 'Add a rule' }).click();
    await page.getByLabel('Left side: Field', { exact: true }).selectOption('tenant.amount');
    await page.getByLabel('Right side: Value', { exact: true }).fill('1');
    await page.getByLabel('Field of the effect 1', { exact: true }).selectOption('lease.total');
    await page.getByRole('button', { name: 'Save the rule' }).click();
    await expect(page.getByRole('alert')).toContainText('The document would not be valid');
    expect(await axe(page)).toEqual([]);
  });

  test('refuses the rule over the limit of 500 with a message', async ({ page }) => {
    await page.goto('/rule-builder.html?full=1');
    await page.getByRole('button', { name: 'Add a rule' }).click();
    await page.getByLabel('Left side: Field', { exact: true }).selectOption('tenant.amount');
    await page.getByLabel('Right side: Value', { exact: true }).fill('1');
    await page.getByLabel('Field of the effect 1', { exact: true }).selectOption('lease.total');
    await page.getByRole('button', { name: 'Save the rule' }).click();
    await expect(page.getByRole('alert')).toContainText('A document has at most 500 rules.');
    expect((await recorded(page)).saves).toEqual([]);
  });

  test('is read-only without structure: nothing that changes a rule can be used', async ({
    page,
  }) => {
    await page.goto('/rule-builder.html?readOnly=1');
    await expect(
      page.getByRole('status').filter({ hasText: 'You cannot change the rules of this document.' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add a rule' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Change rule r_spouse' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Delete rule r_spouse' })).toBeDisabled();
    // The sentences stay readable.
    await expect(page.getByText(SPOUSE_SENTENCE, { exact: true })).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });

  test('deletes a rule', async ({ page }) => {
    await page.goto('/rule-builder.html');
    await page.getByRole('button', { name: 'Delete rule r_spouse' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'The rule was deleted.' }),
    ).toBeVisible();
    expect((await recorded(page)).removes).toEqual(['r_spouse']);
  });

  test('every step is operable from the keyboard, with visible focus', async ({ page }) => {
    await page.goto('/rule-builder.html');
    await page.getByRole('button', { name: 'Add a rule' }).focus();
    await page.keyboard.press('Enter');
    // Focus moves into the form.
    await expect(page.getByRole('heading', { name: 'New rule' })).toBeFocused();
    const focusVisible = async (): Promise<boolean> =>
      page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el) return false;
        const s = getComputedStyle(el);
        return (
          el.matches(':focus-visible') &&
          ((s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== 'none')
        );
      });
    // Tab through the controls: each is reached, in order, and shows focus.
    const order: string[] = [];
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('Tab');
      const name = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return el?.id || el?.textContent?.trim() || el?.tagName || '';
      });
      order.push(name);
      expect(await focusVisible(), `focus is not visible on ${name}`).toBe(true);
      if (name === 'Cancel') break;
    }
    expect(order.at(-1)).toBe('Cancel');
    expect(order).toContain('rb-id');
    expect(order).toContain('rb-left-field');
    expect(order).toContain('rb-op');
    expect(order).toContain('rb-right-value');
    expect(order).toContain('rb-then-0-key');
    // Fill the form with the keyboard alone and save with Enter on the button.
    await page.locator('#rb-left-field').focus();
    await page.keyboard.press('ArrowDown');
    await page.locator('#rb-right-value').focus();
    await page.keyboard.type('single');
    await page.locator('#rb-then-0-key').focus();
    await page.keyboard.press('ArrowDown');
    await page.getByRole('button', { name: 'Save the rule' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status').filter({ hasText: 'The rule was saved.' })).toBeVisible();
    expect((await recorded(page)).saves).toHaveLength(1);
  });

  test('axe finds no violation in the list', async ({ page }) => {
    await page.goto('/rule-builder.html');
    expect(await axe(page)).toEqual([]);
  });

  test('axe finds no violation in the open form', async ({ page }) => {
    await page.goto('/rule-builder.html');
    await page.getByRole('button', { name: 'Change rule r_spouse' }).click();
    expect(await axe(page)).toEqual([]);
  });

  test('axe finds no violation in the form with its problems shown', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName === 'firefox', FIREFOX_AXE_ALERT);
    await page.goto('/rule-builder.html');
    await page.getByRole('button', { name: 'Change rule r_spouse' }).click();
    await page.getByLabel('Left side: Field', { exact: true }).selectOption('');
    await page.getByRole('button', { name: 'Save the rule' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });
});
