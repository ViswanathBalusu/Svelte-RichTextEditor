/**
 * The adoption and signing step in the browser (FRW-045 criteria 1, 4 and 6; FRW-046 criterion 1 from
 * the shell's side): "typed" is selected by default and the whole step works from the keyboard;
 * "drawn" and "uploaded" are offered beside it; signature and initials are adopted separately in
 * the one step; the typed name is shown as text; and the field is signed with what was adopted. The
 * server is a stand-in service (harness/frw-045-signing-port.ts); the service over the backend
 * ports is tested in packages/element. Run from the repository root with
 * `DOCEDIT_UI_PORT=57645 pnpm exec playwright test -c packages/ui/playwright.config.ts packages/ui/e2e/frw-045-adoption-step.spec.ts`.
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
const INITIALS = {
  id: 'ffIni000000000001',
  key: 'tenant.initials',
  kind: 'initials',
  label: 'Tenant initials',
  role: 'Tenant',
} as const;

async function begin(page: Page, signing: 'ok' | 'rejected' | 'consent' = 'ok') {
  const h = await open(page, { signing, extended: true });
  await h.activateSignature(FIELD);
  await expect(page.locator(DIALOG)).toBeVisible();
  return h;
}

test.describe('the adoption step (FRW-045)', () => {
  test('selects typed by default and offers drawn and uploaded beside it (criterion 1)', async ({
    page,
  }) => {
    await begin(page);
    const dialog = page.locator(DIALOG);
    const modes = dialog.locator('[role="radio"]');
    await expect(modes).toHaveText(['Type it', 'Draw it', 'Upload an image']);
    await expect(dialog.locator('[data-mode="typed"]')).toHaveAttribute('aria-checked', 'true');
    await expect(dialog.locator('[data-mode="drawn"]')).toHaveAttribute('aria-checked', 'false');
    await expect(dialog.locator('[data-mode="uploaded"]')).toHaveAttribute('aria-checked', 'false');
    // The typed mode is the one shown, with its text field and no drawing area.
    await expect(dialog.locator('input[type="text"]')).toBeVisible();
    await expect(dialog.locator('canvas')).toHaveCount(0);
    expect(await axe(page)).toEqual([]);
  });

  test('works from the keyboard: type, adopt, sign (criterion 1)', async ({ page }) => {
    const h = await begin(page);
    const dialog = page.locator(DIALOG);
    // Focus starts on the selected mode; Tab reaches the text field, then the adopt button.
    await expect(dialog.locator('[data-mode="typed"]')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.locator('input[type="text"]')).toBeFocused();
    await page.keyboard.type('Ada  Lovelace');
    await page.keyboard.press('Tab');
    await expect(dialog.locator('[data-adopt]')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog.locator('[data-adopted="signature"]')).toContainText('Type it');
    await expect(dialog.locator('[data-sign]')).toBeEnabled();
    await dialog.locator('[data-sign]').focus();
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    const log = await h.signingLog();
    // One image went to the service, a PNG made from the typed name; then the field was signed.
    expect(log.adopts).toHaveLength(1);
    expect(log.adopts[0]).toMatchObject({ kind: 'signature', mode: 'typed', type: 'image/png' });
    expect(log.adopts[0]!.size).toBeGreaterThan(0);
    expect(log.signs).toEqual([{ field: FIELD.id, asset: 'asset-1', mode: 'typed' }]);
  });

  test('moves among the modes with the arrow keys', async ({ page }) => {
    await begin(page);
    const dialog = page.locator(DIALOG);
    await page.keyboard.press('ArrowRight');
    await expect(dialog.locator('[data-mode="drawn"]')).toBeFocused();
    await expect(dialog.locator('[data-mode="drawn"]')).toHaveAttribute('aria-checked', 'true');
    await expect(dialog.locator('canvas')).toBeVisible();
    // Drawing is never required: the typed alternative is one key away, and the hint says so.
    await expect(dialog).toContainText('If you cannot draw, choose Type it.');
    await page.keyboard.press('ArrowRight');
    await expect(dialog.locator('input[type="file"]')).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(dialog.locator('[data-mode="typed"]')).toHaveAttribute('aria-checked', 'true');
  });

  test('shows the typed name as text for assistive technology (criterion 6)', async ({ page }) => {
    await begin(page);
    const dialog = page.locator(DIALOG);
    const preview = dialog.locator('[data-typed-preview]');
    await expect(preview).toContainText('Nothing typed yet.');
    const input = dialog.locator('input[type="text"]');
    await input.fill('  Ada   Lovelace ');
    // The text is real text in the page, tidied, and the field is described by it.
    await expect(preview.locator('[data-preview-text]')).toHaveText('Ada Lovelace');
    await expect(input).toHaveAttribute(
      'aria-describedby',
      (await preview.getAttribute('id')) ?? '',
    );
    await expect(preview).toContainText('Preview, as text');
  });

  test('says what is missing before it adopts, and adopts a drawing and an upload (criterion 1)', async ({
    page,
  }) => {
    const h = await begin(page);
    const dialog = page.locator(DIALOG);
    await dialog.locator('[data-adopt]').click();
    await expect(dialog.locator('[data-problem]')).toHaveText('Type your name first.');
    // Drawn: nothing is adopted until something is drawn.
    await dialog.locator('[data-mode="drawn"]').click();
    await dialog.locator('[data-adopt]').click();
    await expect(dialog.locator('[data-problem]')).toHaveText('Draw something first.');
    const canvas = dialog.locator('canvas');
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + 20, box.y + 20);
    await page.mouse.down();
    await page.mouse.move(box.x + 80, box.y + 60, { steps: 4 });
    await page.mouse.up();
    await dialog.locator('[data-adopt]').click();
    await expect(dialog.locator('[data-adopted="signature"]')).toContainText('Draw it');
    // Change it, and upload an image instead.
    await dialog.getByRole('button', { name: 'Change it' }).click();
    await dialog.locator('[data-mode="uploaded"]').click();
    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'mine.png',
      mimeType: 'image/png',
      buffer: Buffer.from('89504e470d0a1a0a', 'hex'),
    });
    await dialog.locator('[data-adopt]').click();
    await expect(dialog.locator('[data-adopted="signature"]')).toContainText('Upload an image');
    const log = await h.signingLog();
    expect(log.adopts.map((a) => [a.mode, a.type])).toEqual([
      ['drawn', 'image/png'],
      ['uploaded', 'image/png'],
    ]);
  });

  test('says a refused image in words and keeps the step open', async ({ page }) => {
    await begin(page, 'rejected');
    const dialog = page.locator(DIALOG);
    await dialog.locator('input[type="text"]').fill('Ada');
    await dialog.locator('[data-adopt]').click();
    await expect(dialog.locator('[data-problem]')).toContainText('The image was refused.');
    await expect(dialog.locator('[data-sign]')).toBeDisabled();
  });

  test('adopts initials separately from the signature, in the same step (criterion 4)', async ({
    page,
  }) => {
    const h = await begin(page);
    const dialog = page.locator(DIALOG);
    await dialog.locator('input[type="text"]').fill('Ada Lovelace');
    await dialog.locator('[data-adopt]').click();
    await expect(dialog.locator('[data-adopted="signature"]')).toBeVisible();
    // The same step switches to the initials, which start empty and are adopted on their own.
    await dialog.locator('[data-switch-kind]').click();
    await expect(dialog.locator('[data-adopted]')).toHaveCount(0);
    await expect(dialog.getByLabel('Your initials')).toHaveValue('');
    await expect(dialog.locator('[data-sign]')).toBeDisabled();
    await dialog.getByLabel('Your initials').fill('AL');
    await dialog.locator('[data-adopt]').click();
    await expect(dialog.locator('[data-adopted="initials"]')).toBeVisible();
    const log = await h.signingLog();
    expect(log.adopts.map((a) => a.kind)).toEqual(['signature', 'initials']);
    expect(log.adopts[0]!.filename).toBe('signature-typed.png');
    expect(log.adopts[1]!.filename).toBe('initials-typed.png');
  });

  test('signs an initials field with the initials, and asks for the initials when only a signature was adopted', async ({
    page,
  }) => {
    const h = await open(page, { signing: 'ok', extended: true });
    await h.activateSignature(FIELD);
    const dialog = page.locator(DIALOG);
    await dialog.locator('input[type="text"]').fill('Ada Lovelace');
    await dialog.locator('[data-adopt]').click();
    await dialog.locator('[data-sign]').click();
    await expect(dialog).toHaveCount(0);
    // The initials field: the signature adopted earlier is not offered for it.
    await h.activateSignature(INITIALS);
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-adopted]')).toHaveCount(0);
    await expect(dialog.locator('[data-sign]')).toBeDisabled();
    await dialog.locator('input[type="text"]').fill('AL');
    await dialog.locator('[data-adopt]').click();
    await dialog.locator('[data-sign]').click();
    await expect(dialog).toHaveCount(0);
    expect((await h.signingLog()).signs.map((s) => s.field)).toEqual([FIELD.id, INITIALS.id]);
  });

  test('says in words that the sign request was refused for the consent', async ({ page }) => {
    const h = await begin(page, 'consent');
    const dialog = page.locator(DIALOG);
    await dialog.locator('input[type="text"]').fill('Ada');
    await dialog.locator('[data-adopt]').click();
    await dialog.locator('[data-sign]').click();
    await expect(dialog.locator('[data-problem]')).toHaveText(
      'Accept the consent text before signing.',
    );
    await expect(dialog).toBeVisible();
    expect((await h.signingLog()).signs).toEqual([]);
  });

  test('closes with Escape and tells the service', async ({ page }) => {
    const h = await begin(page);
    await page.keyboard.press('Escape');
    await expect(page.locator(DIALOG)).toHaveCount(0);
    expect((await h.signingLog()).dismissed).toBe(1);
  });
});
