/**
 * The shell's print command under `no-print` (UX-040 criterion 3; lane V-UX-031-045, round 17).
 * Under the restriction `document.print` is disabled with `reason.query.no-print`, `exec` refuses
 * it and the host is not asked to print; removing the restriction enables it at once, without a
 * reload, and running it asks the host once. Run with
 * `DOCEDIT_UI_PORT=57270 pnpm exec playwright test -c packages/ui/playwright.config.ts packages/ui/e2e/ux-040-print-command.spec.ts --project=<browser>`.
 */
import { expect, open, test } from './helpers.ts';

const LIMITED = {
  rev: 2,
  docRole: 'editor',
  caps: ['view', 'comment', 'suggest', 'edit'],
  scopes: { body: ['view', 'comment', 'suggest', 'edit'] },
  restrictions: ['no-print'],
};

const UNRESTRICTED = { ...LIMITED, rev: 3, restrictions: [] };

test.describe('the print command under no-print (UX-040 criterion 3)', () => {
  test('under no-print the print command is disabled with its reason and exec refuses it', async ({
    page,
  }) => {
    const h = await open(page, {
      extended: true,
      features: ['exports'],
      print: true,
      permissions: LIMITED,
    });
    await expect.poll(async () => (await h.state('document.print')).enabled).toBe(false);
    expect((await h.state('document.print')).reasonKey).toBe('reason.query.no-print');
    expect(await h.exec('document.print')).toEqual({ ran: false, reason: 'not-applicable' });
    expect(await h.printRequests()).toHaveLength(0);
    // The restriction does not touch the export command's own answer or other commands (criterion 6).
    expect(await h.state('view.zoomIn')).toMatchObject({ enabled: true });
  });

  test('removing the restriction enables the print command at once, and running it asks the host', async ({
    page,
  }) => {
    const h = await open(page, {
      extended: true,
      features: ['exports'],
      print: true,
      permissions: LIMITED,
    });
    await expect.poll(async () => (await h.state('document.print')).enabled).toBe(false);
    await h.setPermissions(UNRESTRICTED);
    await expect.poll(async () => (await h.state('document.print')).enabled).toBe(true);
    expect(await h.exec('document.print')).toEqual({ ran: true, reason: null });
    expect(await h.printRequests()).toHaveLength(1);
  });
});
