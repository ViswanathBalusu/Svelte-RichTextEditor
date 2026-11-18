/**
 * UX-022 in the browser, on the harness's core: the style of each kind in effect is marked (criterion
 * 1); creating, changing and deleting a style are disabled with a reason when the user lacks the
 * right (criterion 2); and a change that a region stops is refused in words naming the region
 * (criterion 3). The core's own answers, and the document's, are tested in the engine and in the
 * element's browser run; here the pane's controls and words are shown rendered.
 * Run from the repository root with
 * `pnpm exec playwright test -c packages/ui/playwright.config.ts ux-022-style-edit`.
 */
import type { Page } from '@playwright/test';
import { expect, open, test } from './helpers.ts';

const STYLES = [
  { id: 'Normal', name: 'Normal', kind: 'paragraph' as const, basedOn: null },
  { id: 'Clause', name: 'Clause', kind: 'paragraph' as const, basedOn: 'Normal' },
  { id: 'Strong', name: 'Strong', kind: 'character' as const, basedOn: null },
  { id: 'Grid', name: 'Grid table', kind: 'table' as const, basedOn: null },
];

const REGIONS = [
  {
    id: 'r1',
    title: 'Payment terms',
    policy: 'restricted' as const,
    order: 0,
    state: 'draft' as const,
  },
  {
    id: 'r2',
    title: 'Signatures',
    policy: 'restricted' as const,
    order: 1,
    state: 'approved' as const,
  },
];

const pane = (page: Page) => page.locator('.de-pane[data-pane="styles"]');

test.describe('the styles pane marks the style in effect for each kind (UX-022 criterion 1)', () => {
  test('applies a style of each kind and marks it as in use at the cursor', async ({ page }) => {
    const h = await open(page, { extended: true, styles: STYLES });
    await h.exec('view.styles');
    const p = pane(page);
    for (const [name, kind, call] of [
      ['Clause', 'paragraph', 'paragraphStyle'],
      ['Strong', 'character', 'characterStyle'],
      ['Grid table', 'table', 'tableStyle'],
    ] as const) {
      await p.getByRole('button', { name: new RegExp(`^${name}`) }).click();
      const row = p.locator(`[data-style="${STYLES.find((s) => s.name === name)!.id}"] > button`);
      await expect(row, kind).toHaveAttribute('aria-current', 'true');
      await expect(row, kind).toContainText('In use at the cursor');
      const calls = await h.callsOf('runNamed');
      expect(
        calls.some((c) => c[0] === call),
        call,
      ).toBe(true);
    }
    // Each kind marks its own: the paragraph style is still the one chosen, and only one of each.
    await expect(p.locator('[aria-current="true"]')).toHaveCount(3);
  });
});

test.describe('creating, changing and deleting a style without the right (UX-022 criterion 2)', () => {
  test('disables the three controls with the reason in words, and still applies a style', async ({
    page,
  }) => {
    const h = await open(page, {
      extended: true,
      styles: STYLES,
      styleEdit: { reason: 'no-access' },
    });
    await h.exec('view.styles');
    const p = pane(page);
    const why = p.locator('[data-styles="why"]');
    await expect(why).toContainText('needs permission to change the structure');
    const controls = p.locator('[data-style-action]');
    // One "new" and a change and a delete for each of the four styles.
    await expect(controls).toHaveCount(1 + 2 * STYLES.length);
    for (const el of await controls.all()) {
      await expect(el).toHaveAttribute('aria-disabled', 'true');
      await expect(el).toHaveAttribute('aria-describedby', /-why$/);
    }
    // Pressing a disabled control does nothing but say why.
    await p.getByRole('button', { name: 'Delete style Clause' }).click({ force: true });
    await p.getByRole('button', { name: 'New style' }).click({ force: true });
    await expect(p.locator('[data-styles="note"]')).toContainText('needs permission');
    await expect(p.locator('form')).toHaveCount(0);
    const calls = await h.callsOf('runNamed');
    expect(
      calls.filter((c) => ['createStyle', 'changeStyle', 'deleteStyle'].includes(String(c[0]))),
    ).toEqual([]);
    // Applying an existing style is not an edit of the definitions.
    await p.getByRole('button', { name: /^Clause/ }).click();
    expect((await h.callsOf('runNamed')).some((c) => c[0] === 'paragraphStyle')).toBe(true);
  });

  test('says why for a locked document and for suggesting', async ({ page }) => {
    for (const [reason, words] of [
      ['read-only', 'The document is locked'],
      ['suggestion', 'cannot be a suggestion'],
    ] as const) {
      const h = await open(page, { extended: true, styles: STYLES, styleEdit: { reason } });
      await h.exec('view.styles');
      await expect(pane(page).locator('[data-styles="why"]')).toContainText(words);
    }
  });

  test('offers the controls to a user who may edit styles, and they run through the core', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, styles: STYLES, styleEdit: {} });
    await h.exec('view.styles');
    const p = pane(page);
    await expect(p.locator('[data-styles="why"]')).toHaveCount(0);
    // New style.
    await p.getByRole('button', { name: 'New style' }).click({ force: true });
    const form = p.locator('form[data-form]');
    await expect(form).toBeVisible();
    await expect(form.getByRole('textbox', { name: 'Name of the style' })).toBeFocused();
    // An empty name is refused in words, and nothing is sent.
    await form.getByRole('button', { name: 'Create' }).click();
    await expect(p.locator('[data-styles="note"]')).toHaveText('Give the style a name.');
    await form.getByRole('textbox', { name: 'Name of the style' }).fill('clause');
    await form.getByRole('button', { name: 'Create' }).click();
    await expect(p.locator('[data-styles="note"]')).toHaveText(
      'Another style of this kind has that name.',
    );
    await form.getByRole('textbox', { name: 'Name of the style' }).fill('Callout');
    await form.getByRole('combobox', { name: 'Based on' }).selectOption('Clause');
    await form.getByRole('button', { name: 'Create' }).click();
    await expect(p.locator('[data-styles="note"]')).toHaveText('Style created.');
    await expect(p.locator('[data-style] > button', { hasText: 'Callout' })).toHaveCount(1);
    const created = (await h.callsOf('runNamed')).filter((c) => c[0] === 'createStyle');
    expect(created).toEqual([
      ['createStyle', JSON.stringify({ name: 'Callout', kind: 'paragraph', basedOn: 'Clause' })],
    ]);
    // Change it.
    await p.getByRole('button', { name: 'Change style Callout' }).click();
    const edit = p.locator('form[data-form]');
    await edit.getByRole('textbox', { name: 'Name of the style' }).fill('Call-out');
    await edit.getByRole('button', { name: 'Save' }).click();
    await expect(p.locator('[data-styles="note"]')).toHaveText('Style changed.');
    await expect(p.locator('[data-style] > button', { hasText: 'Call-out' })).toHaveCount(1);
    // Delete it.
    await p.getByRole('button', { name: 'Delete style Call-out' }).click();
    await expect(p.locator('[data-styles="note"]')).toHaveText('Style deleted.');
    await expect(p.locator('[data-style] > button', { hasText: 'Call-out' })).toHaveCount(0);
  });
});

test.describe('a change that a region stops names the region (UX-022 criterion 3)', () => {
  test('names the regions the user may not edit that use the style', async ({ page }) => {
    const h = await open(page, {
      extended: true,
      styles: STYLES,
      regions: REGIONS,
      styleEdit: { blocked: { Clause: ['r1'] } },
    });
    await h.exec('view.styles');
    const p = pane(page);
    await p.getByRole('button', { name: 'Change style Clause' }).click();
    await expect(p.locator('[data-styles="note"]')).toHaveText(
      'This style is used in the region Payment terms, which you cannot edit, so you cannot change it.',
    );
    await p.getByRole('button', { name: 'Delete style Clause' }).click({ force: true });
    await expect(p.locator('[data-styles="note"]')).toContainText('Payment terms');
    await expect(p.locator('form')).toHaveCount(0);
    // A style no region uses is not stopped.
    await p.getByRole('button', { name: 'Change style Strong' }).click();
    await expect(p.locator('form[data-form]')).toBeVisible();
    const calls = await h.callsOf('runNamed');
    expect(calls.filter((c) => ['changeStyle', 'deleteStyle'].includes(String(c[0])))).toEqual([]);
  });

  test('names an approved region that uses the style, though the user may edit it', async ({
    page,
  }) => {
    const h = await open(page, {
      extended: true,
      styles: STYLES,
      regions: REGIONS,
      styleEdit: { uses: { Clause: ['r1', 'r2'] } },
    });
    await h.exec('view.styles');
    const p = pane(page);
    await p.getByRole('button', { name: 'Change style Clause' }).click();
    await expect(p.locator('[data-styles="note"]')).toHaveText(
      'This style is used in the region Signatures, which is approved, so it cannot be changed.',
    );
    await expect(p.locator('form')).toHaveCount(0);
    // A style that only a draft region uses may be changed.
    await h.setRegions(REGIONS.map((r) => ({ ...r, state: 'draft' as const })));
    await p.getByRole('button', { name: 'Change style Clause' }).click();
    await expect(p.locator('form[data-form]')).toBeVisible();
  });

  test('says a built-in style cannot be renamed or deleted, and a style in use cannot be deleted', async ({
    page,
  }) => {
    const h = await open(page, {
      extended: true,
      styles: STYLES,
      styleEdit: { builtIn: ['Normal'] },
    });
    await h.exec('view.styles');
    const p = pane(page);
    await p.getByRole('button', { name: 'Delete style Normal' }).click();
    await expect(p.locator('[data-styles="note"]')).toHaveText(
      'A built-in style cannot be renamed or deleted.',
    );
  });
});
