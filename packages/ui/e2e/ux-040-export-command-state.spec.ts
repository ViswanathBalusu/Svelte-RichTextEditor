/**
 * Output restrictions in the command states (UX-040 criteria 1, 4 and 6; lane U-UX-031-045).
 * Under `no-export` the registry's `document.export` command is disabled with the reason, a
 * command that is not an output action (`review.comment`) stays enabled, and removing the
 * restriction enables the export command again without a reload. Run with
 * `DOCEDIT_UI_PORT=56275 pnpm exec playwright test -c packages/ui/playwright.config.ts packages/ui/e2e/ux-040-export-command-state.spec.ts --project=<browser>`.
 */
import { expect, open, test } from './helpers.ts';

const LIMITED = {
  rev: 2,
  docRole: 'editor',
  caps: ['view', 'comment', 'suggest', 'edit'],
  scopes: { body: ['view', 'comment', 'suggest', 'edit'] },
  restrictions: ['no-export'],
};

const UNRESTRICTED = { ...LIMITED, rev: 3, restrictions: [] };

test.describe('output restrictions in the command states (UX-040)', () => {
  test('under no-export the export command is disabled with its reason; other commands are not refused', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, features: ['exports'], permissions: LIMITED });
    await expect.poll(async () => (await h.state('document.export')).enabled).toBe(false);
    const exportState = await h.state('document.export');
    expect(exportState.reasonKey).toBe('reason.query.no-export');
    // Criterion 6: a command that is not an output action is not refused by the restriction.
    expect(await h.state('view.zoomIn')).toMatchObject({ enabled: true });
  });

  test('removing the restriction enables the export command at once, without a reload', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, features: ['exports'], permissions: LIMITED });
    await expect.poll(async () => (await h.state('document.export')).enabled).toBe(false);
    await h.setPermissions(UNRESTRICTED);
    await expect.poll(async () => (await h.state('document.export')).enabled).toBe(true);
  });
});
