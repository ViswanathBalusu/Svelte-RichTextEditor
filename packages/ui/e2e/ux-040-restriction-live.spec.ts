/**
 * Output restrictions added while the command is idle, and the other features under a restriction
 * (UX-040 criteria 4 and 6; lane V-UX-031-045, round 15). The access changes through the harness's
 * `setPermissions`, the same call the shell makes on `perm.changed`. No reload happens between the
 * states. Run with
 * `DOCEDIT_UI_PORT=57270 pnpm exec playwright test -c packages/ui/playwright.config.ts packages/ui/e2e/ux-040-restriction-live.spec.ts --project=<browser>`.
 */
import { expect, open, test } from './helpers.ts';

const OPEN = {
  rev: 2,
  docRole: 'editor',
  caps: ['view', 'comment', 'suggest', 'edit'],
  scopes: { body: ['view', 'comment', 'suggest', 'edit'] },
  restrictions: [] as string[],
};

const NO_EXPORT = { ...OPEN, rev: 3, restrictions: ['no-export'] };

test.describe('output restrictions arrive live (UX-040 criteria 4 and 6)', () => {
  test('adding no-export while the export command is idle disables it at once, without a reload', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, features: ['exports'], permissions: OPEN });
    await expect.poll(async () => (await h.state('document.export')).enabled).toBe(true);
    await h.setPermissions(NO_EXPORT);
    await expect.poll(async () => (await h.state('document.export')).enabled).toBe(false);
    expect((await h.state('document.export')).reasonKey).toBe('reason.query.no-export');
  });

  test('under no-export, commenting, navigation and viewing stay available', async ({ page }) => {
    const h = await open(page, {
      extended: true,
      features: ['exports'],
      comments: true,
      permissions: NO_EXPORT,
    });
    await h.setThreadAnchor({
      selection: { kind: 'block', id: 'fig1' },
      scopes: [['view', 'comment']],
    });
    await h.frames(2);
    await expect.poll(async () => (await h.state('document.export')).enabled).toBe(false);
    // Criterion 6: comments, navigation and viewing are not refused by the restriction.
    expect(await h.state('review.comment')).toMatchObject({ offered: true, enabled: true });
    expect(await h.state('view.zoomIn')).toMatchObject({ enabled: true });
    await expect(
      page.locator('.de-editing-surface, [data-testid="document"], main').first(),
    ).toBeVisible();
  });
});
