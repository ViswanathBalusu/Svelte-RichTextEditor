/**
 * The consent step in the browser (FRW-044 criteria 1, 4 and 5; FRW-033 from the shell's side): the
 * text the workflow names is shown in full before any signing action, nothing is pre-selected, the
 * adoption and signing controls are absent until the participant accepts, the text and the accept
 * control are reached and named from the keyboard, and the participant can decline instead. The
 * server is a stand-in service (harness/frw-044-consent-port.ts); the service over the workflow
 * port is tested in packages/element, and the route in services/document-service. Run from the
 * repository root with
 * `DOCEDIT_UI_PORT=57744 pnpm exec playwright test -c packages/ui/playwright.config.ts packages/ui/e2e/frw-044-consent-step.spec.ts`.
 */
import type { Page } from '@playwright/test';
import { axe, expect, open, test } from './helpers.ts';

const DIALOG = '[data-dialog="sign"]';
const FIELD = {
  id: 'ffSig000000000001',
  key: 'tenant.signature',
  kind: 'signature',
  label: 'Tenant signature',
  role: 'Tenant',
} as const;
const PARAGRAPHS = [
  'I agree to sign this document electronically and to be bound by it.',
  'I confirm that I have read the document and that the signature I adopt is mine.',
  'I understand that the time, the connection and the device I use are recorded as evidence.',
];

async function begin(
  page: Page,
  consent: 'required' | 'accepted' | 'none' | 'unreadable' | 'refused' = 'required',
) {
  const h = await open(page, { signing: 'ok', consent, extended: true });
  await h.activateSignature(FIELD);
  await expect(page.locator(DIALOG)).toBeVisible();
  return h;
}

test.describe('the consent step (FRW-044)', () => {
  test('shows the text in full before any signing action, with nothing pre-selected (criterion 1)', async ({
    page,
  }) => {
    const h = await begin(page);
    const dialog = page.locator(DIALOG);
    const text = dialog.getByRole('region', { name: 'Consent text' });
    await expect(text).toBeVisible();
    await expect(text.locator('p')).toHaveText(PARAGRAPHS);
    await expect(text).toHaveAttribute('data-text-id', 'esign-consent');
    await expect(text).toHaveAttribute('data-text-version', '3');
    // The dialog says what is happening, and offers accept and decline, neither of them chosen.
    await expect(dialog.getByRole('dialog')).toHaveCount(0);
    await expect(dialog.locator('[data-accept]')).toHaveText('I accept this text');
    await expect(dialog.locator('[data-decline]')).toHaveText('I decline');
    await expect(dialog.locator('input:checked, [aria-checked="true"]')).toHaveCount(0);
    // No signing action exists yet: no adoption, no mode, no sign button, no kind switch.
    for (const gone of ['[data-adopt]', '[data-sign]', '[role="radio"]', '[data-switch-kind]'])
      await expect(dialog.locator(gone)).toHaveCount(0);
    expect(await h.consentLog()).toEqual({ loads: 1, accepts: 0, declines: [] });
    expect((await h.signingLog()).signs).toEqual([]);
    expect(await axe(page)).toEqual([]);
  });

  test('accepts by an explicit action, and only then offers the adoption and signing (criterion 1)', async ({
    page,
  }) => {
    const h = await begin(page);
    const dialog = page.locator(DIALOG);
    await dialog.locator('[data-accept]').click();
    await expect(dialog.locator('[data-consent-text]')).toHaveCount(0);
    await expect(dialog.locator('[data-mode="typed"]')).toHaveAttribute('aria-checked', 'true');
    expect(await h.consentLog()).toEqual({ loads: 1, accepts: 1, declines: [] });
    // The step goes on as before: type, adopt, sign.
    await dialog.locator('input[type="text"]').fill('Ada Lovelace');
    await dialog.locator('[data-adopt]').click();
    await dialog.locator('[data-sign]').click();
    await expect(dialog).toHaveCount(0);
    expect((await h.signingLog()).signs).toEqual([
      { field: FIELD.id, asset: 'asset-1', mode: 'typed' },
    ]);
  });

  test('is readable and operable from the keyboard, with named controls (criterion 4)', async ({
    page,
  }) => {
    const h = await begin(page);
    const dialog = page.locator(DIALOG);
    // Focus starts on the text, which is a focusable, named region, so it can be scrolled and read.
    const text = dialog.getByRole('region', { name: 'Consent text' });
    await expect(text).toBeFocused();
    // The region is described by the instruction above it, and its content is the whole text.
    await expect(text).toHaveAccessibleDescription(
      'Read this text in full. You can sign only after you accept it.',
    );
    expect((await text.innerText()).replace(/\n+/g, '\n').trim()).toBe(PARAGRAPHS.join('\n'));
    // Tab reaches accept, then decline, then cancel, each by its name.
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'I accept this text' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'I decline' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    // Back to accept, and accept with the keyboard.
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: 'I accept this text' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog.locator('[data-mode="typed"]')).toBeVisible();
    expect((await h.consentLog()).accepts).toBe(1);
  });

  test('offers a decline instead, which needs a reason and signs nothing (criterion 5)', async ({
    page,
  }) => {
    const h = await begin(page);
    const dialog = page.locator(DIALOG);
    await dialog.locator('[data-decline]').click();
    const reason = dialog.getByLabel('Why are you declining? The reason is sent to the sender.');
    await expect(reason).toBeVisible();
    // The text is still there, and a blank reason is not sent.
    await expect(dialog.getByRole('region', { name: 'Consent text' })).toBeVisible();
    await dialog.locator('[data-decline-confirm]').click();
    await expect(dialog.locator('[data-problem]')).toHaveText('Say why you are declining first.');
    expect((await h.consentLog()).declines).toEqual([]);
    // Going back keeps the text and the choice open.
    await dialog.locator('[data-decline-back]').click();
    await expect(dialog.locator('[data-accept]')).toBeVisible();
    await dialog.locator('[data-decline]').click();
    await reason.fill('  I do not agree to the terms  ');
    expect(await axe(page)).toEqual([]);
    await dialog.locator('[data-decline-confirm]').click();
    await expect(dialog.locator('[data-declined]')).toHaveText('You declined. Nothing was signed.');
    expect(await h.consentLog()).toEqual({
      loads: 1,
      accepts: 0,
      declines: ['I do not agree to the terms'],
    });
    for (const gone of ['[data-adopt]', '[data-sign]', '[role="radio"]'])
      await expect(dialog.locator(gone)).toHaveCount(0);
    expect((await h.signingLog()).signs).toEqual([]);
  });

  test('goes straight to the adoption when the text was accepted before, or there is none', async ({
    page,
  }) => {
    for (const consent of ['accepted', 'none'] as const) {
      const h = await begin(page, consent);
      const dialog = page.locator(DIALOG);
      await expect(dialog.locator('[data-mode="typed"]')).toBeVisible();
      await expect(dialog.locator('[data-consent-text]')).toHaveCount(0);
      expect((await h.consentLog()).accepts).toBe(0);
      await page.reload();
    }
  });

  test('offers no signing while the text cannot be read, and reads it again on request', async ({
    page,
  }) => {
    const h = await begin(page, 'unreadable');
    const dialog = page.locator(DIALOG);
    await expect(dialog.locator('[data-consent-unavailable]')).toHaveText(
      'The service did not answer. Try again.',
    );
    for (const gone of ['[data-adopt]', '[data-sign]', '[data-accept]'])
      await expect(dialog.locator(gone)).toHaveCount(0);
    await dialog.locator('[data-consent-retry]').click();
    await expect(dialog.getByRole('region', { name: 'Consent text' })).toBeVisible();
    expect((await h.consentLog()).loads).toBe(2);
  });

  test('says so when the acceptance is refused, and still offers no signing', async ({ page }) => {
    const h = await begin(page, 'refused');
    const dialog = page.locator(DIALOG);
    await dialog.locator('[data-accept]').click();
    await expect(dialog.locator('[data-problem]')).toHaveText(
      'This text cannot be accepted by you now.',
    );
    await expect(dialog.locator('[data-sign]')).toHaveCount(0);
    expect((await h.consentLog()).accepts).toBe(1);
  });
});
