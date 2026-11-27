/**
 * EXP-113 criterion 4: the accessibility checker pane asks the export service for its list of
 * pictures without alternative text and shows the count beside its own list. The core is the
 * harness's fake (`test/support/fake-core.ts`), whose `preflight` answers what the test sets. Run
 * with `pnpm exec playwright test -c packages/ui/playwright.config.ts packages/ui/e2e/exp-113-checker-export-list.spec.ts`.
 */
import { expect, open, test } from './helpers.ts';

const ALT = (blockId: string) => ({
  severity: 'warning',
  code: 'image_without_alt',
  blockId,
  message: 'an image has no alternative text (09 §13)',
});

test.describe('the checker asks the export for its list (EXP-113)', () => {
  test('shows how many pictures the PDF export reports without alternative text', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, checker: true, features: ['exports'] });
    await h.setExportPreflight([
      ALT('fNoAlt'),
      ALT('fNoAlt'),
      ALT('pOther'),
      {
        severity: 'warning',
        code: 'table_cannot_span_pages',
        blockId: 't1',
        message: 'a table cannot span pages',
      },
    ]);
    await h.exec('view.checker');
    const pane = page.locator('.de-pane[data-pane="checker"]');
    const note = pane.locator('[data-status="export-alt"]');
    await expect(note).toHaveText('The PDF export reports 3 pictures without alternative text.');
    await expect(note).toHaveAttribute('data-count', '3');
    expect(await h.exportPreflights()).toContain('pdf');
  });

  test('shows nothing about the export when it reports no picture without alternative text', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, checker: true, features: ['exports'] });
    await h.setExportPreflight([]);
    await h.exec('view.checker');
    const pane = page.locator('.de-pane[data-pane="checker"]');
    await expect(pane.locator('[data-status="count"]')).toBeVisible();
    await expect(pane.locator('[data-status="export-alt"]')).toHaveCount(0);
  });
});
