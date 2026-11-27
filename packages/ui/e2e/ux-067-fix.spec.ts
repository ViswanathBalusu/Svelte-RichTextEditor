/**
 * The accessibility checker pane offers the fix for each kind of issue (UX-067 criterion 2): a field
 * for alternative text and for link text, a button for the header row, the heading level and the
 * text colour. The fix goes to the core's `fixBlock`; the issue leaves the list when the core's
 * document changes. An issue the user may not fix offers nothing. The harness core applies the fix
 * to its own document; the real core's fixes are tested in packages/engine/test/ux-067-fix-block.test.ts.
 */
import { expect, open, test } from './helpers.ts';

const PERMISSIONS = {
  rev: 1,
  docRole: 'editor',
  caps: ['view', 'comment', 'suggest', 'edit'],
  scopes: { 'region:rLegal': ['view', 'comment'] },
};

const REGIONS = [
  {
    id: 'rLegal',
    title: 'Legal review',
    policy: 'restricted' as const,
    order: 0,
    state: 'draft' as const,
  },
];

async function openChecker(page: Parameters<typeof open>[0], permissions = PERMISSIONS) {
  const h = await open(page, { extended: true, checker: true, permissions, regions: REGIONS });
  await h.exec('view.checker');
  return { h, pane: page.locator('.de-pane[data-pane="checker"]') };
}

test.describe('the checker pane offers a fix for each issue (UX-067 criterion 2)', () => {
  test('offers the field or command of each kind, and nothing where the user may not fix', async ({
    page,
  }) => {
    const { pane } = await openChecker(page);
    await expect(pane.locator('li[data-block="fNoAlt"] [data-fix="alt-text"] input')).toBeVisible();
    await expect(pane.locator('li[data-block="fNoAlt"] [data-fix-apply]')).toHaveText(
      'Set alternative text',
    );
    await expect(pane.locator('li[data-block="pLink"] [data-fix="link-text"] input')).toBeVisible();
    await expect(pane.locator('li[data-block="tNoHeader"] [data-fix-apply]')).toHaveText(
      'Make the first row a header row',
    );
    await expect(pane.locator('li[data-block="hTooDeep"] [data-fix-apply]')).toHaveText(
      'Change to heading level 2',
    );
    // The navy paragraph reads better with white text.
    await expect(pane.locator('li[data-block="pNavy"] [data-fix-apply]')).toHaveText(
      'Use white text',
    );
    // The figure in the restricted region is not the user's to fix: no field, no button.
    await expect(pane.locator('li[data-block="fLegal"] [data-fixable="false"]')).toBeVisible();
    await expect(pane.locator('li[data-block="fLegal"] [data-fix]')).toHaveCount(0);
  });

  test('offers nothing to a reader who may change nothing', async ({ page }) => {
    const { pane } = await openChecker(page, {
      rev: 1,
      docRole: 'viewer',
      caps: ['view'],
      scopes: { 'region:rLegal': ['view'] },
    });
    await expect(pane.locator('li.de-checker-item').first()).toBeVisible();
    await expect(pane.locator('[data-fix]')).toHaveCount(0);
  });

  test('sends each fix to the core, and the issue goes when the document is fixed', async ({
    page,
  }) => {
    const { h, pane } = await openChecker(page);
    const count = pane.locator('[data-status="count"]');
    await expect(count).toHaveText('6 accessibility issues found.');

    await pane.locator('li[data-block="fNoAlt"] input').fill('A chart of sales');
    await pane.locator('li[data-block="fNoAlt"] [data-fix-apply]').click();
    await expect(pane.locator('li[data-block="fNoAlt"]')).toHaveCount(0);
    await expect(count).toHaveText('5 accessibility issues found.');
    await expect(pane.locator('[data-status="fix"]')).toHaveText('Fixed.');

    await pane.locator('li[data-block="pLink"] input').fill('Sales report');
    await pane.locator('li[data-block="pLink"] [data-fix-apply]').click();
    await pane.locator('li[data-block="tNoHeader"] [data-fix-apply]').click();
    await pane.locator('li[data-block="hTooDeep"] [data-fix-apply]').click();
    await pane.locator('li[data-block="pNavy"] [data-fix-apply]').click();

    // Only the figure the user may not fix is left.
    await expect(pane.locator('li.de-checker-item')).toHaveCount(1);
    await expect(pane.locator('li[data-block="fLegal"]')).toHaveCount(1);
    await expect(count).toHaveText('1 accessibility issues found.');

    expect(await h.checkerFixCalls()).toEqual([
      { id: 'fNoAlt', fix: { fix: 'alt-text', text: 'A chart of sales' } },
      { id: 'pLink', fix: { fix: 'link-text', text: 'Sales report', index: 0 } },
      { id: 'tNoHeader', fix: { fix: 'table-header' } },
      { id: 'hTooDeep', fix: { fix: 'heading-level', level: 2 } },
      { id: 'pNavy', fix: { fix: 'text-colour', colour: '#FFFFFF' } },
    ]);
  });

  test('sends nothing for empty text, and says so', async ({ page }) => {
    const { h, pane } = await openChecker(page);
    await pane.locator('li[data-block="fNoAlt"] [data-fix-apply]').click();
    await expect(pane.locator('[data-status="fix"]')).toHaveText('This could not be changed.');
    expect(await h.checkerFixCalls()).toEqual([]);
    await expect(pane.locator('li[data-block="fNoAlt"]')).toHaveCount(1);
  });
});
