/**
 * Lane U-FRW-073-089: browser checks of the participant's role markers under forced colours
 * (FRW-077 criterion 4) and of the summary as fields are fixed (FRW-078 criterion 3).
 * Run from the repository root with
 * `pnpm exec playwright test -c packages/ui/playwright.config.ts packages/ui/e2e/frw-077-078.spec.ts`
 * and `DOCEDIT_UI_PORT` set to a port in 56430 to 56439.
 */
import { expect, open, test } from './helpers.ts';

const FILL = {
  active: true,
  fields: [
    { id: 'f1', label: 'Name', required: true, filled: true, invalid: null },
    { id: 'f2', label: 'Date of birth', required: true, filled: false, invalid: null },
    { id: 'f3', label: 'Amount', required: true, filled: true, invalid: 'range' },
    { id: 'f4', label: 'Notes', required: false, filled: false, invalid: null },
  ],
};

const ROLES = {
  active: true,
  roles: ['role_tenant'],
  fields: [
    {
      id: 'm1',
      label: 'Income',
      required: true,
      filled: false,
      invalid: null,
      assignee: 'role_tenant',
      role: { name: 'Tenant', color: '#0d47a1', order: 0 },
    },
    {
      id: 'o1',
      label: 'Landlord name',
      required: true,
      filled: false,
      invalid: null,
      assignee: 'role_landlord',
      role: { name: 'Landlord', color: '#b71c1c', order: 1 },
    },
    { id: 'n1', label: 'Reference', required: true, filled: false, invalid: null, assignee: null },
  ],
};

test.describe('role markers under forced colours (FRW-077 criterion 4)', () => {
  test('keeps each shape visible as a system colour, not lost to the page background', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'forced colours are emulated in Chromium only');
    await page.emulateMedia({ forcedColors: 'active' });
    await open(page, { extended: true, fill: ROLES });
    const pane = page.locator('.de-pane[data-pane="fill"]');
    await page
      .getByRole('region', { name: 'Filling in' })
      .getByRole('button', { name: 'What is left' })
      .click();
    for (const id of ['m1', 'o1']) {
      const row = pane.locator(`[data-field-row="${id}"]`);
      const icon = row.locator('.de-role-icon');
      await expect(icon).toBeVisible();
      const colours = await icon.evaluate((el) => {
        const cs = getComputedStyle(el);
        const li = el.closest('li')!;
        return { shape: cs.backgroundColor, row: getComputedStyle(li).backgroundColor };
      });
      // The shape is painted in a system colour that differs from the row, so it stays visible.
      expect(colours.shape).not.toBe('rgba(0, 0, 0, 0)');
      expect(colours.shape).not.toBe(colours.row);
    }
  });
});

test.describe('the summary as fields are fixed (FRW-078 criterion 3)', () => {
  test('a fixed field leaves the list at once, and the empty status is a live region', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, fill: FILL });
    const bar = page.getByRole('region', { name: 'Filling in' });
    await bar.getByRole('button', { name: 'What is left' }).click();
    const pane = page.locator('.de-pane[data-pane="fill"]');
    const left = pane.locator('[data-field]');
    await expect(left).toHaveCount(2);

    // Fix the invalid amount only: it leaves the list, the other field stays.
    await h.setFill({
      active: true,
      fields: FILL.fields.map((f) => (f.id === 'f3' ? { ...f, invalid: null } : f)),
    });
    await expect(left).toHaveCount(1);
    await expect(left.first()).toContainText('Date of birth');
    await expect(pane.locator('[data-status="fill-progress"]')).toHaveText(
      '2 of 3 required fields filled',
    );
    await expect(pane.locator('[data-status="fill-left"]')).toHaveText('');

    // Fix the last one: the list is empty and the status says so in a status region.
    await h.setFill({
      active: true,
      fields: FILL.fields.map((f) => ({ ...f, filled: true, invalid: null })),
    });
    await expect(left).toHaveCount(0);
    const status = pane.locator('[data-status="fill-left"]');
    await expect(status).toHaveText('Nothing is left to fill.');
    await expect(status).toHaveAttribute('role', 'status');
  });
});
