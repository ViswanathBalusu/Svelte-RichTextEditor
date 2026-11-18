/**
 * FRW-035 criterion 6 in a browser: the guided bar changes what it says when the participant's
 * status changes (`wf.changed` moves the fill summary), with no reload. The bar is the shell's own
 * `FillBar` over the fake core; the element's side (the status from the port into the summary) is
 * `packages/element/test/frw-035-wf-changed.test.ts`. Run from the repository root with
 * `pnpm exec playwright test -c packages/ui/playwright.config.ts packages/ui/e2e/frw-035-wf-changed.spec.ts`
 * and `DOCEDIT_UI_PORT` set to a free port.
 */
import { expect, open, test } from './helpers.ts';

const FIELDS = [{ id: 'f1', label: 'Name', required: true, filled: false, invalid: null }];

test.describe('the guided bar follows the participant status (FRW-035 criterion 6)', () => {
  test('waiting, paused and active, without a reload', async ({ page }) => {
    const h = await open(page, {
      extended: true,
      fill: { active: false, inactive: 'waiting', fields: FIELDS },
    });
    const bar = page.getByRole('region', { name: 'Filling in' });
    const inactive = bar.locator('[data-status="fill-inactive"]');
    await expect(inactive).toBeVisible();
    const waiting = await inactive.innerText();

    await h.setFill({ active: false, inactive: 'paused', fields: FIELDS });
    await expect(inactive).toBeVisible();
    await expect(inactive).not.toHaveText(waiting);

    await h.setFill({ active: true, fields: FIELDS });
    await expect(bar.locator('[data-status="fill-inactive"]')).toHaveCount(0);
    await expect(bar.locator('[data-status="fill-progress"]')).toBeVisible();
  });
});
