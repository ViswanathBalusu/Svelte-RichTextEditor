/**
 * The full toolbar's contextual groups for pictures and fields (UX-007, criterion 2), and the
 * layout switch keeps the selection, the editing surface and the single mount (UX-007, criterion
 * 6, in part). The table and header-and-footer groups are in commands.spec.ts. The harness
 * document does not scroll, so the scroll position is not checked here. Lane U-UX-001-015.
 */
import { expect, focusSurface, focused, open, test } from './helpers.ts';

test.describe('contextual groups for pictures and fields (UX-007, criterion 2)', () => {
  for (const context of ['picture', 'field'] as const) {
    test(`the ${context} group appears while the selection is in its object, and focus does not move`, async ({
      page,
    }) => {
      const h = await open(page, { toolbar: 'full' });
      await h.register(`${context}.sample`, 'command.format.bold', false, { group: context });
      await focusSurface(page);
      const tab = page.locator(`[role="tab"][data-group="${context}"]`);
      await expect(tab).toHaveCount(0);
      await h.setSelection({ contexts: [context] });
      await expect(tab).toBeVisible();
      await expect(tab).toHaveAttribute('data-contextual', '');
      expect((await focused(page)).className).toContain('de-editing-surface');
      await h.setSelection({ contexts: [] });
      await expect(tab).toHaveCount(0);
      expect((await focused(page)).className).toContain('de-editing-surface');
    });
  }
});

test.describe('switching the layout keeps the view (UX-007, criterion 6, in part)', () => {
  test('the selection and the editing surface are untouched by a switch between full and compact', async ({
    page,
  }) => {
    const h = await open(page, { toolbar: 'full' });
    await focusSurface(page);
    await h.setSelection({ empty: false, marks: ['italic'] });
    const selection = await h.selection();
    const surface = await page.evaluate(
      () =>
        document.getElementById('host')!.shadowRoot!.querySelector('.de-editing-surface')!
          .innerHTML,
    );
    await h.setSettings({ toolbar: 'compact' });
    await expect(page.getByRole('toolbar', { name: 'Editing' })).toBeVisible();
    await h.setSettings({ toolbar: 'full' });
    await expect(page.getByRole('tablist')).toBeVisible();
    expect(await h.selection()).toEqual(selection);
    const after = await page.evaluate(
      () =>
        document.getElementById('host')!.shadowRoot!.querySelector('.de-editing-surface')!
          .innerHTML,
    );
    expect(after).toBe(surface);
    expect((await h.calls()).filter((c) => c === 'mountBody')).toHaveLength(1);
  });
});
