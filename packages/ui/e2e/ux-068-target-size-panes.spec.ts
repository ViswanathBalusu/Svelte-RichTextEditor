/**
 * Pointer target size in every pane and dialog the shell builds itself (UX-068, criterion 2,
 * extended by lane V-UX-061-075, 2026-11-14). The earlier tests measured the toolbar's tabs
 * (ux-068-target-size.spec.ts), the context menu and the export dialog (ux-068-axe-states.spec.ts).
 * Here each pane and dialog of ux-068-axe-panes-dialogs.spec.ts is opened in the same states and
 * every visible control in the shell root is measured against 24 by 24 CSS pixels (WCAG 2.2 2.5.8).
 *
 * A radio or checkbox inside its `label.de-check` is measured by the label, which takes the pointer
 * (the decision recorded in docs/adr/0329-lane-V-UX-061-075.md, decision 1). The input on its own
 * is not measured then. Run from the repository root with
 * `DOCEDIT_UI_PORT=57290 pnpm exec playwright test -c packages/ui/playwright.config.ts ux-068-target-size-panes`.
 */
import type { Page } from '@playwright/test';
import { expect, open, test } from './helpers.ts';

const STYLES = [
  { id: 'Normal', name: 'Normal', kind: 'paragraph' as const },
  { id: 'Heading1', name: 'Heading 1', kind: 'paragraph' as const },
  { id: 'Strong', name: 'Strong', kind: 'character' as const },
  { id: 'Grid', name: 'Grid table', kind: 'table' as const },
];

const REGIONS = [
  {
    id: 'r1',
    title: 'Terms',
    policy: 'restricted' as const,
    order: 0,
    state: 'draft' as const,
    editors: { roles: ['owner'], principals: ['user:u1', 'group:legal'] },
  },
  {
    id: 'r2',
    title: 'Annex',
    policy: 'inherit' as const,
    order: 1,
    state: 'draft' as const,
    editors: { roles: ['editor', 'owner'], principals: [] },
  },
  { id: 'r3', title: null, policy: 'confidential' as const, order: 2, state: 'draft' as const },
];
const OWNER = {
  rev: 3,
  docRole: 'owner',
  caps: ['view', 'comment', 'suggest', 'edit', 'structure', 'manage'],
  scopes: {
    body: ['view', 'comment', 'suggest', 'edit'],
    'region:r1': ['view', 'comment'],
    'region:r2': ['view', 'comment', 'suggest', 'edit'],
    'region:r3': [],
  },
};

const FILL = {
  active: true,
  inactive: null,
  fields: [
    { id: 'f1', label: 'Name', required: true, filled: true, invalid: null },
    { id: 'f2', label: 'Date of birth', required: true, filled: false, invalid: null },
    { id: 'f3', label: 'Amount', required: true, filled: true, invalid: 'range' as const },
    { id: 'f4', label: 'Notes', required: false, filled: false, invalid: null },
  ],
};

/**
 * Every visible, enabled control of the shell root that is smaller than 24 by 24 CSS pixels, and
 * how many controls were measured. Content of the document (`.de-page`) is not a shell control.
 */
async function measureShell(page: Page): Promise<{ measured: number; small: string[] }> {
  return page.evaluate(() => {
    const root = document.getElementById('host')!.shadowRoot!;
    const out: string[] = [];
    let measured = 0;
    const selector =
      'button, [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="radio"], [role="checkbox"], select, input:not([type="hidden"]), textarea, a[href]';
    const seen = new Set<Element>();
    for (const raw of root.querySelectorAll<HTMLElement>(selector)) {
      if (raw.closest('.de-page, [data-content], [hidden]')) continue;
      // A radio or checkbox inside its label is measured by the label, which takes the pointer.
      const check = raw.closest('label.de-check');
      const el = (check ?? raw) as HTMLElement;
      if (seen.has(el)) continue;
      seen.add(el);
      if (el.getClientRects().length === 0) continue;
      if ((el as HTMLButtonElement).disabled) continue;
      measured += 1;
      const box = el.getBoundingClientRect();
      if (box.width < 24 || box.height < 24) {
        const name = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30);
        out.push(
          `${el.tagName.toLowerCase()}.${el.className} ${Math.round(box.width)}x${Math.round(box.height)} "${name}"`,
        );
      }
    }
    return { measured, small: out };
  });
}

function expectTargets(result: { measured: number; small: string[] }, state: string): void {
  // An empty state would pass vacuously: at least one control has to have been measured.
  expect(result.measured, `controls measured in ${state}`).toBeGreaterThan(0);
  expect(result.small, `controls under 24 by 24 CSS pixels in ${state}`).toEqual([]);
}

test.describe('pointer targets in each pane and dialog (UX-068, criterion 2, extended)', () => {
  test('the styles pane', async ({ page }) => {
    const h = await open(page, { extended: true, styles: STYLES });
    expect(await h.exec('view.styles')).toEqual({ ran: true, reason: null });
    await expect(page.locator('.de-pane[data-pane="styles"]')).toContainText('Heading 1');
    expectTargets(await measureShell(page), 'the styles pane');
  });

  test('the permissions pane, a region expanded and the directory search listed', async ({
    page,
  }) => {
    const h = await open(page, {
      extended: true,
      regions: REGIONS,
      permissions: OWNER,
      grants: [{ region: 'r1', principal: 'user:u1', role: 'editor' }],
    });
    expect(await h.exec('view.permissions')).toEqual({ ran: true, reason: null });
    const pane = page.locator('.de-pane[data-pane="permissions"]');
    await expect(pane.locator('[data-region]').first()).toBeVisible();
    expectTargets(await measureShell(page), 'the permissions pane');
    await pane.locator('[data-region="r1"]').getByRole('button').click();
    await pane.getByRole('combobox', { name: 'Find a person or group' }).fill('l');
    await expect(
      pane.getByRole('listbox', { name: 'People and groups found' }).getByRole('option'),
    ).toHaveText([/Ada Lovelace/, /Legal team/]);
    expectTargets(await measureShell(page), 'the permissions pane with the search listed');
  });

  test('the recovered pane with an item of each kind', async ({ page }) => {
    const h = await open(page, {
      extended: true,
      regions: [{ id: 'r1', title: 'Terms', policy: 'restricted', order: 0, state: 'draft' }],
    });
    await h.setAside([
      { id: 'i1', reason: 'rebase', commit: null, text: 'My words', seq: 4 },
      {
        id: 'i2',
        reason: 'permission_denied',
        commit: 'c1',
        text: 'Other words',
        seq: 5,
        scope: 'region:r1',
        scopes: ['region:r1', 'defs'],
        changedBy: 'u2',
        changedAt: '2026-11-13T09:30:00.000Z',
      },
    ]);
    expect(await h.exec('view.recovered')).toEqual({ ran: true, reason: null });
    await expect(page.locator('.de-pane[data-pane="recovered"] [data-item]')).toHaveCount(2);
    expectTargets(await measureShell(page), 'the recovered pane');
  });

  test('the shortcuts pane', async ({ page }) => {
    const h = await open(page, { extended: true });
    expect(await h.exec('view.shortcuts')).toEqual({ ran: true, reason: null });
    await expect(page.locator('.de-pane[data-pane="shortcuts"] kbd').first()).toBeVisible();
    expectTargets(await measureShell(page), 'the shortcuts pane');
  });

  test('the fill pane, opened from the filling-in bar', async ({ page }) => {
    await open(page, { extended: true, fill: FILL });
    const bar = page.getByRole('region', { name: 'Filling in' });
    expectTargets(await measureShell(page), 'the filling-in bar');
    await bar.getByRole('button', { name: 'What is left' }).click();
    await expect(page.locator('.de-pane[data-pane="fill"] [data-field]')).toHaveCount(2);
    expectTargets(await measureShell(page), 'the fill pane');
  });

  test('the language dialog, valid and with its error shown', async ({ page }) => {
    const h = await open(page, { extended: true, language: 'en-GB' });
    await h.setSelection({ lang: 'de-CH' });
    await page.locator('.de-status [data-status="language"]').click();
    const dialog = page.getByRole('dialog', { name: 'Language of the selected text' });
    await expect(dialog).toBeVisible();
    expectTargets(await measureShell(page), 'the language dialog');
    await dialog.getByRole('textbox', { name: 'Language tag' }).fill('not a tag!');
    await expect(dialog.getByText('This is not a valid language tag.')).toBeVisible();
    expectTargets(await measureShell(page), 'the language dialog with its error');
  });

  test('the region dialog, and with its error shown', async ({ page }) => {
    await open(page, {
      extended: true,
      regions: [],
      permissions: OWNER,
      toolbar: 'full',
      selection: { empty: false },
    });
    await page.getByRole('tab', { name: 'Insert' }).click();
    const button = page.getByRole('tabpanel').locator('[data-command-id="insert.region"]');
    await button.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Make a region' });
    await expect(dialog).toBeVisible();
    expectTargets(await measureShell(page), 'the region dialog');
    await page.keyboard.press('Enter');
    await expect(dialog.getByText('Enter a title.')).toBeVisible();
    expectTargets(await measureShell(page), 'the region dialog with its error');
  });

  test('the comment box, empty and with the mention list shown', async ({ page }) => {
    const h = await open(page, { extended: true, comments: true });
    expect(await h.exec('review.comment')).toEqual({ ran: true, reason: null });
    const box = page.locator('[data-dialog="comment"]');
    await expect(box).toBeVisible();
    expectTargets(await measureShell(page), 'the comment box');
    await box.getByRole('textbox', { name: 'Comment' }).pressSequentially('Please ask @Gr');
    await expect(box.getByRole('option')).toHaveText([/Grace Hopper/]);
    expectTargets(await measureShell(page), 'the comment box with the mention list');
  });
});
