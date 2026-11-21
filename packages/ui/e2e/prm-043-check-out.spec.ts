/**
 * Check-out of a region from the permissions pane (PRM-043 criterion 7, lane w5): the control is
 * offered only when the core has a leases service, which it has only when the backend announces
 * `leases`. With the service, the pane offers check-out for a region the user can edit, says who
 * holds one that someone else holds, and says why a region cannot be checked out. A refusal from
 * the service is shown in words and announced.
 * Run with `DOCEDIT_UI_PORT=56505 pnpm exec playwright test -c packages/ui/playwright.config.ts packages/ui/e2e/prm-043-check-out.spec.ts`
 * (set DOCEDIT_UI_PORT to a free port in 56500 to 56509).
 */
import type { Page } from '@playwright/test';
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

const EDITOR = {
  rev: 3,
  docRole: 'editor',
  caps: ['view', 'comment', 'suggest', 'edit'],
  scopes: {
    body: ['view', 'comment', 'suggest', 'edit'],
    'region:r1': ['view', 'comment', 'suggest', 'edit'],
    'region:r2': ['view', 'comment'],
    'region:r3': ['view', 'comment'],
  },
};

const REGIONS = [
  region('r1', 'Terms'),
  region('r2', 'Held by Bob', {
    order: 1,
    editors: { roles: [], principals: [], leasedTo: 'bob' },
  }),
  region('r3', 'Schedule', { order: 2, state: 'approved' as const }),
];

async function select(page: Page, id: string) {
  const pane = page.locator('.de-pane[data-pane="permissions"]');
  await pane.locator(`[data-region="${id}"]`).getByRole('button').click();
  return pane;
}

test.describe('check-out in the permissions pane (PRM-043, criterion 7)', () => {
  test('offers no check-out when the backend has no leases service', async ({ page }) => {
    const h = await open(page, { extended: true, regions: REGIONS, permissions: EDITOR });
    await h.exec('view.permissions');
    const pane = await select(page, 'r1');
    await expect(pane.locator('[data-lease]')).toHaveCount(0);
    await expect(pane.getByRole('button', { name: 'Check out' })).toHaveCount(0);
  });

  test('checks a region out and announces it', async ({ page }) => {
    const h = await open(page, {
      extended: true,
      regions: REGIONS,
      permissions: EDITOR,
      leases: { holder: 'alice' },
    });
    await h.exec('view.permissions');
    const pane = await select(page, 'r1');
    await expect(pane.locator('[data-lease="offer"]')).toBeVisible();
    await pane.getByRole('button', { name: 'Check out' }).click();
    await expect(pane.locator('[data-status="lease"]')).toHaveText('Checked out.');
    expect(await h.leaseCalls()).toEqual(['acquire r1']);
  });

  test('says who holds a region someone else holds, with no button', async ({ page }) => {
    const h = await open(page, {
      extended: true,
      regions: REGIONS,
      permissions: EDITOR,
      leases: { holder: 'alice' },
    });
    await h.exec('view.permissions');
    const pane = await select(page, 'r2');
    await expect(pane.locator('[data-lease="other"]')).toContainText('has this region checked out');
    await expect(pane.getByRole('button', { name: 'Check out' })).toHaveCount(0);
    await expect(pane.getByRole('button', { name: 'Release' })).toHaveCount(0);
  });

  test('says why an approved region cannot be checked out', async ({ page }) => {
    const h = await open(page, {
      extended: true,
      regions: REGIONS,
      permissions: EDITOR,
      leases: { holder: 'alice' },
    });
    await h.exec('view.permissions');
    const pane = await select(page, 'r3');
    await expect(pane.locator('[data-lease="blocked"]')).toContainText(
      'An approved region cannot be checked out.',
    );
    await expect(pane.getByRole('button', { name: 'Check out' })).toHaveCount(0);
  });

  test('shows a refusal from the service in words', async ({ page }) => {
    const h = await open(page, {
      extended: true,
      regions: REGIONS,
      permissions: EDITOR,
      leases: { holder: 'alice' },
    });
    await h.exec('view.permissions');
    const pane = await select(page, 'r1');
    await h.refuseNextLease('conflict');
    await pane.getByRole('button', { name: 'Check out' }).click();
    await expect(pane.locator('[data-status="lease"]')).toHaveText(
      'Someone else has this region checked out.',
    );
  });
});
