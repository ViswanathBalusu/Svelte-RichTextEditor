/**
 * EXP-065 criterion 3, the dialog half (lane w2): choosing a diagnostic whose block has changed
 * after the exported `seq` moves the editor and tells the author so; a block that has not changed
 * closes the dialog as before. The core here is the harness's fake (`test/support/fake-core.ts`):
 * its `blockChangedSince` says that the block `changed` has changed. The real editing core does
 * not give `selectBlock` or `blockChangedSince` yet (see the story Notes). Run with
 * `pnpm exec playwright test -c packages/ui/playwright.config.ts packages/ui/e2e/exp-065-diagnostic-changed.spec.ts`.
 */
import { axe, expect, open, test } from './helpers.ts';

const DIAGNOSTICS = [
  {
    severity: 'warning',
    code: 'tab_approximate',
    blockId: 'changed',
    message: 'A tab stop was approximated.',
  },
  {
    severity: 'warning',
    code: 'table_cannot_span_pages',
    blockId: 'p7',
    message: 'A table could not span pages.',
  },
];

test.describe('a diagnostic whose block changed since the export (EXP-065)', () => {
  test('marks it in the list, moves the editor and says that the block has changed', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, features: ['exports'] });
    await h.exec('document.export');
    const dialog = page.getByRole('dialog', { name: 'Export' });
    await dialog.getByRole('button', { name: 'Export' }).click();
    await h.updateExport('job1', {
      state: 'completed',
      progress: 100,
      result: { url: '/assets/result.pdf', pages: 2, converged: true },
      diagnostics: DIAGNOSTICS,
    });
    const items = dialog.getByRole('list', { name: 'Problems found' }).getByRole('button');
    await expect(items).toHaveText([
      /Warning\s*A tab stop was approximated\.\s*Changed since this export/,
      /Warning\s*A table could not span pages\.\s*$/,
    ]);
    await expect(dialog.locator('[data-export="changed"]')).toHaveCount(1);
    expect(await axe(page)).toEqual([]);

    await items.nth(0).click();
    // The editor was asked to move to the block, with the job's `seq` asked about first or after.
    expect(await h.callsOf('selectBlock')).toEqual([['changed']]);
    expect((await h.callsOf('blockChangedSince')).at(-1)).toEqual(['changed', 7]);
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole('status').filter({ hasText: 'changed since this export' }),
    ).toHaveText(
      'The editor has moved to that part. It has changed since this export, so the problem may no longer be there.',
    );

    // A block that has not changed: the editor moves and the dialog closes.
    await items.nth(1).click();
    await expect(dialog).toHaveCount(0);
    expect(await h.callsOf('selectBlock')).toEqual([['changed'], ['p7']]);
  });
});
