/**
 * The permissions pane shows a region's state with an icon and text (PRM-048 criterion 1, lane
 * V-PRM-035-051). The icon is decorative (aria-hidden), so the text carries the meaning.
 * Run with `DOCEDIT_UI_PORT=56500 pnpm exec playwright test -c packages/ui/playwright.config.ts packages/ui/e2e/prm-048-region-lock.spec.ts`
 * (Chromium, Firefox and WebKit).
 */
import { expect, open, test } from './helpers.ts';

const REGIONS = [
  {
    id: 'r1',
    title: 'Terms',
    policy: 'inherit' as const,
    order: 0,
    state: 'draft' as const,
    editors: { roles: ['owner'], principals: [] },
  },
  {
    id: 'r2',
    title: 'Schedule',
    policy: 'inherit' as const,
    order: 1,
    state: 'approved' as const,
    editors: { roles: [], principals: [] },
  },
];

const OWNER = {
  rev: 3,
  docRole: 'owner',
  caps: ['view', 'comment', 'suggest', 'edit', 'structure', 'manage'],
  scopes: {
    body: ['view', 'comment', 'suggest', 'edit'],
    'region:r1': ['view', 'comment', 'suggest', 'edit'],
    'region:r2': ['view', 'comment'],
  },
};

test.describe('a region state shows an icon and text (PRM-048, criterion 1)', () => {
  test('each state badge has a decorative icon and its text label', async ({ page }) => {
    const h = await open(page, { extended: true, regions: REGIONS, permissions: OWNER });
    await h.exec('view.permissions');
    const pane = page.locator('.de-pane[data-pane="permissions"]');

    const draft = pane.locator('[data-region="r1"] .de-badge');
    await expect(draft).toHaveText(/Draft/);
    await expect(draft.locator('.de-badge-icon')).toHaveText('○');
    await expect(draft.locator('.de-badge-icon')).toHaveAttribute('aria-hidden', 'true');

    const approved = pane.locator('[data-region="r2"] .de-badge');
    await expect(approved).toHaveText(/Approved/);
    await expect(approved.locator('.de-badge-icon')).toHaveText('●');
  });
});
