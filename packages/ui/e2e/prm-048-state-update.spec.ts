/**
 * The shell's half of PRM-048 criterion 5 (lane U-PRM-035-051): when the core's `regions` view
 * changes, the lock-indicator words and the state badge follow without a reload. The view is set on
 * the harness's fake core (`setRegions`); no `perm.changed` and no real core is involved, because no
 * core derives the `regions` view yet, and no lease is shown (criterion 3 is not built). This test
 * alone does not meet criterion 5.
 * Run with `DOCEDIT_UI_PORT=56500 pnpm exec playwright test -c packages/ui/playwright.config.ts packages/ui/e2e/prm-048-state-update.spec.ts`
 * (Chromium, Firefox and WebKit).
 */
import { expect, open, test } from './helpers.ts';

const APPROVED_WORDS = 'It is approved. An owner must change its state before it can be edited.';

const REGIONS = [
  {
    id: 'r2',
    title: 'Schedule',
    policy: 'inherit' as const,
    order: 0,
    state: 'approved' as const,
    editors: { roles: [], principals: [] },
  },
];

// The user may not edit r2 (no `edit` under region:r2), so the core draws a lock indicator there.
const OWNER = {
  rev: 3,
  docRole: 'owner',
  caps: ['view', 'comment', 'suggest', 'edit', 'structure', 'manage'],
  scopes: {
    body: ['view', 'comment', 'suggest', 'edit'],
    'region:r2': ['view', 'comment'],
  },
};

test.describe('a region state change updates the labels without a reload (PRM-048, criterion 5)', () => {
  test('the lock indicator and the pane badge follow a state change', async ({ page }) => {
    const h = await open(page, { extended: true, regions: REGIONS, permissions: OWNER });
    await h.exec('view.permissions');
    const pane = page.locator('.de-pane[data-pane="permissions"]');

    await expect
      .poll(async () => (await h.regionLabels())?.['r2']?.description)
      .toBe(APPROVED_WORDS);
    await expect(pane.locator('[data-region="r2"] .de-badge')).toHaveText(/Approved/);

    // The owner returns the region to draft; the host sends the new list.
    await h.setRegions([
      {
        id: 'r2',
        title: 'Schedule',
        policy: 'inherit' as const,
        order: 0,
        state: 'draft' as const,
        editors: { roles: ['owner'], principals: [] },
      },
    ]);

    await expect
      .poll(async () => (await h.regionLabels())?.['r2']?.description)
      .toBe('It can be edited by document owners.');
    await expect(pane.locator('[data-region="r2"] .de-badge')).toHaveText(/Draft/);
    await expect(pane.locator('[data-region="r2"] .de-badge')).not.toHaveText(/Approved/);
  });
});
