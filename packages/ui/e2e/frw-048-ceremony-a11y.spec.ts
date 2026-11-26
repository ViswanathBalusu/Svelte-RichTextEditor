/**
 * The signing ceremony without a pointer and with a screen reader (FRW-048 criteria 1, 2 and 6): the
 * whole path (consent, a typed signature, a typed initials field, finish) from the keyboard with a
 * visible focus; the result of each step said in a live region ("consent accepted", "signed 2 of 3",
 * "completed"); axe, target size and reflow on every screen of the ceremony. The services are
 * stand-ins (harness/frw-044-consent-port.ts, frw-045-signing-port.ts, the completion in
 * harness/main.ts); each layer beneath them is tested apart (packages/element, services/document-service).
 * Run from the repository root with
 * `DOCEDIT_UI_PORT=57748 pnpm exec playwright test -c packages/ui/playwright.config.ts packages/ui/e2e/frw-048-ceremony-a11y.spec.ts`.
 */
import type { Locator, Page } from '@playwright/test';
import { axe, expect, open, test } from './helpers.ts';

const DIALOG = '[data-dialog="sign"]';
const SIGNATURE = {
  id: 'ffSig000000000001',
  key: 'tenant.signature',
  kind: 'signature',
  label: 'Tenant signature',
  role: 'Tenant',
} as const;
const INITIALS = {
  id: 'ffIni000000000001',
  key: 'tenant.initials',
  kind: 'initials',
  label: 'Tenant initials',
  role: 'Tenant',
} as const;
const FILL = {
  active: true,
  fields: [{ id: 'f1', label: 'Signature', required: true, filled: true, invalid: null }],
};

async function begin(page: Page, completion: 'ok' | 'invalid' | 'inactive' = 'ok') {
  const h = await open(page, {
    signing: 'ok',
    consent: 'required',
    completion,
    fill: FILL,
    extended: true,
  });
  await h.activateSignature(SIGNATURE);
  await expect(page.locator(DIALOG)).toBeVisible();
  return h;
}

/** Presses Tab until `target` has focus; fails if it is not reached, so a control cannot be skipped. */
async function tabTo(page: Page, target: Locator, limit = 12): Promise<void> {
  const focused = () =>
    target.evaluate((el) => el === (el.getRootNode() as Document | ShadowRoot).activeElement);
  // Forward first. A browser may have left the page's own order (focus after a closed dialog), so a
  // run that does not find the control goes backward, which is still the keyboard alone.
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let i = 0; i < limit; i++) {
      if (await focused()) return;
      await page.keyboard.press(key);
    }
  }
  await expect(target).toBeFocused();
}

/** Whether the focused control shows that it has focus: an outline or a shadow. */
async function focusShown(target: Locator): Promise<boolean> {
  return target.evaluate((el) => {
    const s = getComputedStyle(el);
    return (
      (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) ||
      (s.boxShadow !== 'none' && s.boxShadow !== '')
    );
  });
}

/** Every visible, enabled control of the shell smaller than 24 by 24 CSS pixels (WCAG 2.5.8). */
async function smallTargets(page: Page): Promise<{ measured: number; small: string[] }> {
  return page.evaluate(() => {
    const root = document.getElementById('host')!.shadowRoot!;
    const small: string[] = [];
    let measured = 0;
    const selector =
      'button, [role="button"], [role="radio"], select, input:not([type="hidden"]), textarea, a[href]';
    for (const el of root.querySelectorAll<HTMLElement>(selector)) {
      if (el.closest('.de-page, [data-content], [hidden]')) continue;
      if (el.getClientRects().length === 0 || (el as HTMLButtonElement).disabled) continue;
      measured += 1;
      const box = el.getBoundingClientRect();
      if (box.width < 24 || box.height < 24)
        small.push(
          `${el.tagName.toLowerCase()} ${Math.round(box.width)}x${Math.round(box.height)}`,
        );
    }
    return { measured, small };
  });
}

/** The dialog stays inside the viewport and the page has no horizontal scroll. */
async function reflows(page: Page): Promise<{ overflow: number; outside: boolean }> {
  return page.evaluate((selector) => {
    const root = document.getElementById('host')!.shadowRoot!;
    const dialog = root.querySelector<HTMLElement>(selector);
    const box = dialog?.getBoundingClientRect();
    return {
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      outside: box ? box.left < -1 || box.right > window.innerWidth + 1 : false,
    };
  }, DIALOG);
}

const status = (page: Page, text: string) => page.locator('[role="status"]', { hasText: text });

test.describe('the ceremony from the keyboard (FRW-048 criterion 1)', () => {
  test('runs consent, a typed signature, typed initials and finishing without a pointer', async ({
    page,
  }) => {
    const h = await begin(page);
    const dialog = page.locator(DIALOG);

    // Consent: the text has focus, Tab reaches accept, Enter accepts, and the focus is visible.
    await expect(dialog.getByRole('region', { name: 'Consent text' })).toBeFocused();
    const accept = dialog.getByRole('button', { name: 'I accept this text' });
    await tabTo(page, accept);
    expect(await focusShown(accept)).toBe(true);
    await page.keyboard.press('Enter');
    await expect(dialog.locator('[data-mode="typed"]')).toBeVisible();

    // The signature: typed is the default and focused; Tab to the field, type, Tab to adopt, Enter,
    // then Tab to sign and Enter.
    await expect(dialog.locator('[data-mode="typed"]')).toBeFocused();
    await tabTo(page, dialog.locator('input[type="text"]'));
    await page.keyboard.type('Ada Lovelace');
    const adopt = dialog.locator('[data-adopt]');
    await tabTo(page, adopt);
    expect(await focusShown(adopt)).toBe(true);
    await page.keyboard.press('Enter');
    await expect(dialog.locator('[data-adopted="signature"]')).toBeVisible();
    const sign = dialog.locator('[data-sign]');
    await tabTo(page, sign);
    expect(await focusShown(sign)).toBe(true);
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);

    // The initials field: the consent is not asked again, and the same keys do the same.
    await h.activateSignature(INITIALS);
    await expect(dialog.locator('[data-consent-text]')).toHaveCount(0);
    await expect(dialog.locator('[data-mode="typed"]')).toBeFocused();
    await tabTo(page, dialog.locator('input[type="text"]'));
    await page.keyboard.type('AL');
    await tabTo(page, adopt);
    await page.keyboard.press('Enter');
    await tabTo(page, sign);
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);

    // Finishing: the control is reached by Tab from the page and operated with Enter.
    const finish = page.getByRole('button', { name: 'Finish' });
    await tabTo(page, finish, 80);
    expect(await focusShown(finish)).toBe(true);
    await page.keyboard.press('Enter');
    await expect(status(page, 'Completed. Your part is done.')).toHaveCount(1);

    const log = await h.signingLog();
    expect(log.adopts.map((a) => [a.kind, a.mode])).toEqual([
      ['signature', 'typed'],
      ['initials', 'typed'],
    ]);
    expect(log.signs.map((s) => s.field)).toEqual([SIGNATURE.id, INITIALS.id]);
    expect(await h.consentLog()).toMatchObject({ accepts: 1, declines: [] });
    expect(await h.completionLog()).toEqual({ completes: 1 });
  });

  test('is never trapped: Escape leaves the step at each stage and focus goes back', async ({
    page,
  }) => {
    const h = await begin(page);
    const dialog = page.locator(DIALOG);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect((await h.signingLog()).dismissed).toBe(1);
    // After the acceptance, the adoption stage closes the same way.
    await h.activateSignature(SIGNATURE);
    await dialog.locator('[data-accept]').click();
    await expect(dialog.locator('[data-mode="typed"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    // And Tab stays inside the open dialog (it is modal) while Escape is always there.
    await h.activateSignature(SIGNATURE);
    for (let i = 0; i < 6; i++) await page.keyboard.press('Tab');
    expect(
      await dialog.evaluate((el) => el.contains((el.getRootNode() as ShadowRoot).activeElement)),
    ).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });
});

test.describe('the result of each step is said (FRW-048 criterion 2)', () => {
  test('consent accepted, signed 1 of 3, signed 2 of 3, completed', async ({ page }) => {
    const h = await begin(page);
    const dialog = page.locator(DIALOG);
    await dialog.locator('[data-accept]').click();
    await expect(status(page, 'Consent text accepted.')).toHaveCount(1);

    await dialog.locator('input[type="text"]').fill('Ada Lovelace');
    await dialog.locator('[data-adopt]').click();
    await dialog.locator('[data-sign]').click();
    await expect(status(page, 'Signed: Tenant signature. 1 of 3 signed.')).toHaveCount(1);

    await h.activateSignature(INITIALS);
    await dialog.locator('input[type="text"]').fill('AL');
    await dialog.locator('[data-adopt]').click();
    await dialog.locator('[data-sign]').click();
    await expect(status(page, 'Signed: Tenant initials. 2 of 3 signed.')).toHaveCount(1);

    await page.getByRole('button', { name: 'Finish' }).click();
    await expect(status(page, 'Completed. Your part is done.')).toHaveCount(1);
  });

  test('says how many fields need attention, or that the part cannot be completed now', async ({
    page,
  }) => {
    await open(page, { completion: 'invalid', signing: 'ok', fill: FILL, extended: true });
    await page.getByRole('button', { name: 'Finish' }).click();
    await expect(status(page, '2 fields need attention before you can complete.')).toHaveCount(1);
    await open(page, { completion: 'inactive', signing: 'ok', fill: FILL, extended: true });
    await page.getByRole('button', { name: 'Finish' }).click();
    await expect(status(page, 'You cannot complete now.')).toHaveCount(1);
  });

  test('says in words that the consent step says what it is doing while it works', async ({
    page,
  }) => {
    await begin(page);
    const dialog = page.locator(DIALOG);
    // The text, the buttons and the reason field are named: axe checks every control has a name.
    expect(await axe(page)).toEqual([]);
    await dialog.locator('[data-decline]').click();
    await expect(
      dialog.getByRole('textbox', {
        name: 'Why are you declining? The reason is sent to the sender.',
      }),
    ).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Decline and stop' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Go back to the text' })).toBeVisible();
  });
});

test.describe('every screen of the ceremony (FRW-048 criterion 6)', () => {
  /** The screens in the order of the ceremony, each reached by the controls a person uses. */
  async function screens(page: Page, visit: () => Promise<void>): Promise<string[]> {
    const h = await begin(page);
    const dialog = page.locator(DIALOG);
    const seen: string[] = [];
    const at = async (name: string) => {
      seen.push(name);
      await visit();
    };
    await at('consent');
    await dialog.locator('[data-decline]').click();
    await at('decline');
    await dialog.locator('[data-decline-back]').click();
    await dialog.locator('[data-accept]').click();
    await expect(dialog.locator('[data-mode="typed"]')).toBeVisible();
    await at('typed');
    await dialog.locator('[data-mode="drawn"]').click();
    await at('drawn');
    await dialog.locator('[data-mode="uploaded"]').click();
    await at('uploaded');
    await dialog.locator('[data-mode="typed"]').click();
    await dialog.locator('input[type="text"]').fill('Ada Lovelace');
    await dialog.locator('[data-adopt]').click();
    await expect(dialog.locator('[data-adopted="signature"]')).toBeVisible();
    await at('adopted');
    await dialog.locator('[data-sign]').click();
    await expect(dialog).toHaveCount(0);
    await h.activateSignature(INITIALS);
    await at('initials');
    await page.keyboard.press('Escape');
    await at('finish');
    return seen;
  }

  test('axe reports nothing on any screen', async ({ page }) => {
    const found: string[] = [];
    let current = '';
    const seen = await screens(page, async () => {
      const violations = await axe(page);
      current = String(violations.length);
      if (violations.length > 0) found.push(JSON.stringify(violations));
    });
    expect(current).toBe('0');
    expect(found).toEqual([]);
    expect(seen).toEqual([
      'consent',
      'decline',
      'typed',
      'drawn',
      'uploaded',
      'adopted',
      'initials',
      'finish',
    ]);
  });

  test('every control is at least 24 by 24 CSS pixels on any screen', async ({ page }) => {
    const small: string[] = [];
    let measured = 0;
    await screens(page, async () => {
      const r = await smallTargets(page);
      measured += r.measured;
      small.push(...r.small);
    });
    expect(measured).toBeGreaterThan(8);
    expect(small).toEqual([]);
  });

  test('reflows at 200 per cent zoom (640 CSS pixels) and at 320 pixels, with no sideways scroll', async ({
    page,
  }) => {
    const bad: string[] = [];
    for (const width of [640, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await screens(page, async () => {
        const r = await reflows(page);
        if (r.overflow > 0 || r.outside) bad.push(`${width}: ${JSON.stringify(r)}`);
      });
    }
    expect(bad).toEqual([]);
  });
});
