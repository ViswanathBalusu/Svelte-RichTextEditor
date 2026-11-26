/**
 * PRM-048 criteria 3 and 4 in the permissions pane: a region leased to another user names the holder
 * and when the lease expires, and the state control is there for people who hold `manage` and
 * absent for everyone else. The state is set through the core's `setRegionState` (the harness's fake
 * core records the call and updates its region list, as `perm.changed` does with a real backend).
 * Run with `DOCEDIT_UI_PORT=56501 pnpm exec playwright test -c packages/ui/playwright.config.ts packages/ui/e2e/prm-048-lease-state.spec.ts`
 * (Chromium, Firefox and WebKit; set DOCEDIT_UI_PORT to a free port in 56500 to 56509).
 */
import { expect, open, test } from './helpers.ts';

const region = (id: string, title: string, over: Record<string, unknown> = {}) => ({
  id,
  title,
  policy: 'inherit' as const,
  order: 0,
  state: 'draft' as const,
  editors: { roles: ['editor', 'owner'], principals: [] },
  ...over,
});

const REGIONS = [
  region('r1', 'Terms'),
  region('r2', 'Held by Bob', {
    order: 1,
    editors: {
      roles: [],
      principals: [],
      leasedTo: 'bob',
      leaseExpiresAt: '2026-11-18T10:05:00.000Z',
    },
  }),
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
const EDITOR = { ...OWNER, docRole: 'editor', caps: ['view', 'comment', 'suggest', 'edit'] };

test.describe('a leased region and the state control (PRM-048, criteria 3 and 4)', () => {
  test('names the holder and the expiry of a lease, in the pane and on the lock indicator', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, regions: REGIONS, permissions: EDITOR });
    await h.exec('view.permissions');
    const pane = page.locator('.de-pane[data-pane="permissions"]');
    const hint = pane.locator('[data-region="r2"] [data-region-editors]');
    await expect(hint).toContainText('is editing it at the moment. The lease expires ');
    await expect(hint).toContainText('2026');
    await expect
      .poll(async () => (await h.regionLabels())?.['r2']?.description)
      .toContain('The lease expires');
  });

  test('offers the state control to a user who manages, and sets the state', async ({ page }) => {
    const h = await open(page, {
      extended: true,
      regions: REGIONS,
      permissions: OWNER,
      regionStates: true,
    });
    await h.exec('view.permissions');
    const pane = page.locator('.de-pane[data-pane="permissions"]');
    await pane.locator('[data-region="r1"]').getByRole('button').click();
    const control = pane.locator('[data-region-state]');
    await expect(control).toBeVisible();
    await control.getByRole('combobox').selectOption('approved');
    await control.getByRole('button', { name: 'Change state' }).click();
    await expect(pane.locator('[data-region="r1"] .de-badge')).toHaveText(/Approved/);
    expect(await h.stateCalls()).toEqual(['r1 approved']);
  });

  test('has no state control without manage', async ({ page }) => {
    const h = await open(page, {
      extended: true,
      regions: REGIONS,
      permissions: EDITOR,
      regionStates: true,
    });
    await h.exec('view.permissions');
    const pane = page.locator('.de-pane[data-pane="permissions"]');
    await pane.locator('[data-region="r1"]').getByRole('button').click();
    await expect(pane.locator('[data-region-state]')).toHaveCount(0);
  });

  test('has no state control when the backend offers none', async ({ page }) => {
    const h = await open(page, { extended: true, regions: REGIONS, permissions: OWNER });
    await h.exec('view.permissions');
    const pane = page.locator('.de-pane[data-pane="permissions"]');
    await pane.locator('[data-region="r1"]').getByRole('button').click();
    await expect(pane.locator('[data-region-state]')).toHaveCount(0);
  });
});
