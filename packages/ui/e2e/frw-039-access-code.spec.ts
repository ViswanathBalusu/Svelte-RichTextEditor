/**
 * FRW-039 criterion 6 in a browser: the access code input of the guided bar has a visible label,
 * accepts pasted text, announces errors through a live region and works from the keyboard. The bar
 * is the shell's own `FillBar` over the fake core, whose `accessCode` service answers from a script
 * (a wrong code, too many attempts, then the right one). The element's side (the status `unverified`
 * and the call of the verify endpoint) is `packages/element/test/frw-039-access-code.test.ts`. Run
 * from the repository root with
 * `pnpm exec playwright test -c packages/ui/playwright.config.ts packages/ui/e2e/frw-039-access-code.spec.ts`
 * and `DOCEDIT_UI_PORT` set to a free port.
 */
import { axe, expect, open, test } from './helpers.ts';

const FIELDS = [{ id: 'f1', label: 'Name', required: true, filled: false, invalid: null }];
const UNVERIFIED = { active: false, inactive: 'unverified', fields: FIELDS } as const;

test.describe('the access code input (FRW-039 criterion 6)', () => {
  test('has a visible label tied to the input, and the bar offers no fill controls yet', async ({
    page,
  }) => {
    await open(page, { extended: true, fill: UNVERIFIED, accessCode: [{ ok: true }] });
    const bar = page.getByRole('region', { name: 'Filling in' });
    const input = bar.getByLabel('Access code');
    await expect(input).toBeVisible();
    // The label is real text on the page, not only an attribute.
    await expect(bar.locator('label', { hasText: 'Access code' })).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Submit code' })).toBeVisible();
    await expect(bar.locator('[data-status="fill-progress"]')).toHaveCount(0);
    // The input says what it is for.
    await expect(input).toHaveAccessibleDescription(/Enter the code you were given/);
  });

  test('works from the keyboard and accepts pasted text', async ({ page }) => {
    const h = await open(page, {
      extended: true,
      fill: UNVERIFIED,
      accessCode: [{ ok: false, reason: 'wrong' }],
    });
    const bar = page.getByRole('region', { name: 'Filling in' });
    const input = bar.getByLabel('Access code');
    // A paste event is not cancelled by the input.
    const cancelled = await input.evaluate((el) => {
      const data = new DataTransfer();
      data.setData('text/plain', 'x');
      const event = new ClipboardEvent('paste', {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      });
      el.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(cancelled).toBe(false);

    // Reach the input with Tab alone, insert text as a paste does, and submit with Enter.
    const focused = () =>
      input.evaluate((el) => (el.getRootNode() as ShadowRoot).activeElement === el);
    for (let i = 0; i < 60 && !(await focused()); i++) await page.keyboard.press('Tab');
    expect(await focused()).toBe(true);
    await page.keyboard.insertText('  PASTED-CODE-0192  ');
    await expect(input).toHaveValue('  PASTED-CODE-0192  ');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await h.accessCodeLog()).length).toBe(1);
    // The code is sent trimmed, as typed otherwise.
    expect(await h.accessCodeLog()).toEqual(['PASTED-CODE-0192']);
    // Focus stays in the input so the person can correct it.
    await expect(input).toBeFocused();
  });

  test('tells a wrong code and too many attempts through a live region, then accepts the right one', async ({
    page,
  }) => {
    const h = await open(page, {
      extended: true,
      fill: UNVERIFIED,
      accessCode: [
        { ok: false, reason: 'wrong' },
        { ok: false, reason: 'rate_limited', retryAfterMs: 3500 },
        { ok: true },
      ],
    });
    const bar = page.getByRole('region', { name: 'Filling in' });
    const input = bar.getByLabel('Access code');
    const live = bar.locator('[data-status="access-code-error"]');
    // The region is in the page before it has anything to say.
    await expect(live).toHaveAttribute('role', 'alert');
    await expect(live).toHaveText('');
    await expect(input).not.toHaveAttribute('aria-invalid', 'true');

    await input.fill('wrong');
    await page.keyboard.press('Enter');
    await expect(live).toHaveText('That code is not right. Check it and try again.');
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(input).toHaveAccessibleDescription(/That code is not right/);

    await page.keyboard.press('Enter');
    await expect(live).toHaveText('Too many attempts. Try again in 4 seconds.');

    await page.keyboard.press('Enter');
    await expect.poll(async () => (await h.accessCodeLog()).length).toBe(3);
    // Accepted: the code is cleared, and no error stays.
    await expect(input).toHaveValue('');
    await expect(live).toHaveText('');
    // The core then reports the participant as active, and the bar shows the progress, no reload.
    await h.setFill({ active: true, fields: FIELDS });
    await expect(bar.locator('[data-status="fill-progress"]')).toBeVisible();
    await expect(bar.getByLabel('Access code')).toHaveCount(0);
  });

  test('shows the waiting text, not the input, when the core takes no code', async ({ page }) => {
    await open(page, { extended: true, fill: UNVERIFIED });
    const bar = page.getByRole('region', { name: 'Filling in' });
    await expect(bar.locator('[data-status="fill-inactive"]')).toBeVisible();
    await expect(bar.getByLabel('Access code')).toHaveCount(0);
  });

  // axe injects a style that the page's policy refuses in Firefox and WebKit; a11y.spec.ts flakes the same way there.
  test('axe finds no violation with an error shown', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'axe and the page policy, see above');
    await open(page, {
      extended: true,
      fill: UNVERIFIED,
      accessCode: [{ ok: false, reason: 'wrong' }],
    });
    const bar = page.getByRole('region', { name: 'Filling in' });
    await bar.getByLabel('Access code').fill('x');
    await page.keyboard.press('Enter');
    await expect(bar.locator('[data-status="access-code-error"]')).not.toHaveText('');
    expect(await axe(page)).toEqual([]);
  });
});
