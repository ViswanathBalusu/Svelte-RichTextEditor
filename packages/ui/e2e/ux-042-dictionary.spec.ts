/**
 * Custom dictionaries in the language dialog (UX-042 criterion 3; 13 §6.1; owner decision 34): the
 * person's own words and the tenant's shared words are listed, a word is added to either list and a
 * removable word is removed; the control exists only while the proofing port supports dictionaries.
 * The fake port keeps the lists; what a real port stores, and that later checks honour a word, is
 * packages/engine/test/ux-042-finding-actions.test.ts and the element's run
 * (packages/element/e2e/ux-042-dictionary.spec.ts).
 *
 * Run from the repository root with
 * `pnpm exec playwright test -c packages/ui/playwright.config.ts ux-042-dictionary`.
 */
import type { ProofingStatus } from '../src/core-api.ts';
import { axe, expect, open, test } from './helpers.ts';

const status = (dictionary: boolean): ProofingStatus => ({
  available: true,
  state: 'idle',
  count: 0,
  dictionary,
  current: null,
  atCaret: null,
});

async function openDialog(dictionary: boolean) {
  return async (page: Parameters<typeof open>[0]) => {
    const h = await open(page, {
      extended: true,
      language: 'en-GB',
      proofing: { status: status(dictionary), findings: [] },
    });
    return h;
  };
}

test.describe('the custom dictionaries (UX-042 criterion 3)', () => {
  test('lists the person’s and the shared words, adds to either, and removes what may be removed', async ({
    page,
  }) => {
    const h = await (await openDialog(true))(page);
    await h.setDictionary([
      { word: 'Zork', scope: 'user', removable: true },
      { word: 'Acme', scope: 'tenant', removable: false },
    ]);
    expect(await h.exec('format.language')).toMatchObject({ ran: true });
    const section = page.locator('[data-dictionary]');
    await expect(section).toBeVisible();
    await expect(section.getByRole('heading', { name: 'Custom dictionary (en-GB)' })).toBeVisible();
    await expect(section.locator('[data-entry="Zork"]')).toContainText('yours');
    await expect(section.locator('[data-entry="Acme"]')).toContainText('shared');
    // The shared word is not the person's to remove: no button for it.
    await expect(section.getByRole('button', { name: 'Remove Acme' })).toHaveCount(0);

    await section.getByLabel('Word to add').fill('Quux');
    await section.getByRole('button', { name: 'Add word' }).click();
    await expect(section.locator('[data-entry="Quux"]')).toContainText('yours');
    await section.getByRole('button', { name: 'Remove Zork' }).click();
    await expect(section.locator('[data-entry="Zork"]')).toHaveCount(0);
    expect(await h.dictionaryCalls()).toEqual(
      expect.arrayContaining(['add:en-GB:user:Quux', 'remove:en-GB:user:Zork']),
    );
  });

  test('a shared word needs an administrator: the port refuses, and the dialog says so', async ({
    page,
  }) => {
    const h = await (await openDialog(true))(page);
    await h.exec('format.language');
    const section = page.locator('[data-dictionary]');
    await section.getByLabel('Word to add').fill('Acme');
    await section.getByLabel('Add it to').selectOption('tenant');
    await section.getByRole('button', { name: 'Add word' }).click();
    await expect(section.getByRole('alert')).toContainText('Only an administrator');
    expect(await h.dictionaryEntries()).toEqual([]);

    // An administrator adds it, and may remove it.
    await h.setDictionary([], true);
    await section.getByRole('button', { name: 'Add word' }).click();
    await expect(section.locator('[data-entry="Acme"]')).toContainText('shared');
    await section.getByRole('button', { name: 'Remove Acme' }).click();
    await expect(section.locator('[data-entry="Acme"]')).toHaveCount(0);
  });

  test('is not offered when the port has no dictionary', async ({ page }) => {
    const h = await (await openDialog(false))(page);
    await h.exec('format.language');
    await expect(page.getByRole('dialog', { name: 'Language of the selected text' })).toBeVisible();
    await expect(page.locator('[data-dictionary]')).toHaveCount(0);
  });

  test('has no axe violation with the dictionary shown', async ({ page }) => {
    const h = await (await openDialog(true))(page);
    await h.setDictionary([{ word: 'Zork', scope: 'user', removable: true }]);
    await h.exec('format.language');
    await expect(page.locator('[data-dictionary]')).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });
});
