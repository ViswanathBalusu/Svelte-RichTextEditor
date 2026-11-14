/**
 * PRM-024 criteria 1 and 2 in the rendered recovered-edits pane: a `permission_denied` item, in the
 * shape the engine gives it (`packages/engine/test/prm-024.rejection-explained.test.ts`), names the
 * regions by title and the other parts it refused, and says who changed the permissions and when
 * through the host's directory (`resolveUsers`); otherwise it says only that permissions changed.
 */
import { axe, expect, open, test } from './helpers.ts';

const REGIONS = [
  { id: 'r1', title: 'Terms', policy: 'restricted' as const, order: 0, state: 'draft' as const },
  { id: 'r2', title: null, policy: 'restricted' as const, order: 1, state: 'draft' as const },
];
const AT = '2026-11-13T09:30:00.000Z';

test.describe('a rejected change explained (PRM-024)', () => {
  test('names the regions by title and the definitions, and who changed the permissions and when', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, regions: REGIONS });
    await h.setAside([
      {
        id: 'i1',
        reason: 'permission_denied',
        commit: 'c1',
        text: 'My words',
        seq: 4,
        scope: 'region:r1',
        // The hidden region r2 has no title for this reader, so nothing names it (ADR 0019).
        scopes: ['region:r1', 'region:r2', 'defs'],
        changedBy: 'u2',
        changedAt: AT,
      },
    ]);
    await h.exec('view.recovered');
    const item = page.locator('.de-pane[data-pane="recovered"] [data-item="i1"]');
    await expect(item).toContainText('Not saved: your permissions changed');
    await expect(item.locator('[data-part]')).toHaveText([
      'Region: Terms',
      'Part: the definitions',
    ]);
    // The date as the shell's en-GB table formats it in this browser's time zone.
    const when = await page.evaluate(
      (at) =>
        new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(
          new Date(at),
        ),
      AT,
    );
    await expect(item).toContainText(`Permission changed by Grace Hopper on ${when}`);
    expect(await axe(page)).toEqual([]);
  });

  test('says only that the permissions changed when the client does not know who', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, regions: REGIONS });
    await h.setAside([
      {
        id: 'i1',
        reason: 'permission_denied',
        commit: 'c1',
        text: 'My words',
        seq: 4,
        scope: 'region:r1',
        scopes: ['region:r1'],
        // A server-authored control commit: the time is known, the person is not.
        changedBy: null,
        changedAt: AT,
      },
    ]);
    await h.exec('view.recovered');
    const item = page.locator('.de-pane[data-pane="recovered"] [data-item="i1"]');
    await expect(item).toContainText('Not saved: your permissions changed');
    await expect(item.locator('[data-part]')).toHaveText(['Region: Terms']);
    await expect(item).not.toContainText('Permission changed by');
  });
});
