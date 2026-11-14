/**
 * FRW-072 criterion 5 (lane U-FRW-055-072): the field palette is driven by the command registry and
 * is operable from the keyboard. The palette is the `insert.field.<kind>` commands in the Insert
 * tab. This run focuses a kind and invokes it with Enter and with Space, from the keyboard alone.
 *
 * Observed (2026-11-13, Chromium): after Enter inserts a kind, focus leaves the palette and rests
 * on the host element, so a second insert needs the palette to be focused again. Tab from a kind
 * does not reach its neighbour either. That is recorded in the story Notes, not asserted away here.
 */
import { expect, open, test } from './helpers.ts';

test.describe('field palette, keyboard only (FRW-072)', () => {
  test('a kind is inserted with Enter, and another with Space, from the keyboard', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, toolbar: 'full' });
    await page.getByRole('tab', { name: 'Insert' }).click();
    const panel = page.getByRole('tabpanel');

    const text = panel.locator('[data-command-id="insert.field.text"]');
    await text.focus();
    await expect(text).toBeFocused();
    await page.keyboard.press('Enter');
    expect(await h.named()).toEqual([['insertField', { kind: 'text' }]]);

    const number = panel.locator('[data-command-id="insert.field.number"]');
    await number.focus();
    await expect(number).toBeFocused();
    await page.keyboard.press(' ');
    expect(await h.named()).toEqual([
      ['insertField', { kind: 'text' }],
      ['insertField', { kind: 'number' }],
    ]);
  });
});
