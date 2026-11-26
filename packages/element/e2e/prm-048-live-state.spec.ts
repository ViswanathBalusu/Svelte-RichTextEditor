/**
 * PRM-048 criteria 3 to 5 in the real `<doc-editor>` over the in-memory backend (lane w9): the
 * permissions pane shows a region's state, lets an owner (who holds `manage`) change it, hides the
 * control from an editor, and follows a lease and a state change that arrive as `perm.changed`
 * without a reload. The state change goes the whole way: the select in the pane, the element's
 * `setRegionState`, the backend's permissions port (a control commit), `perm.changed` to the channel,
 * the engine's access, and the region list read again for the pane.
 *
 * The page is the embed page (demo/embed-page.ts); the document is `regionRolesDocId` (one region,
 * "Middle").
 *
 * Run with `DOCEDIT_DEMO_PORT=56592 pnpm exec playwright test -c packages/element/playwright.config.ts
 * packages/element/e2e/prm-048-live-state.spec.ts`.
 */
import { type Page, expect, test } from '@playwright/test';
import { events, openEmbed } from './embed-helpers.ts';

const EL = 'doc-editor[data-test="prm048"]';

async function mount(page: Page, role: 'owner' | 'editor'): Promise<void> {
  await page.evaluate(async (role) => {
    const e = (window as unknown as { __embed: Record<string, unknown> }).__embed as unknown as {
      backend(sub: string, role: string, docs: string[]): unknown;
      regionRolesDocId: string;
    };
    const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
    el.dataset['test'] = 'prm048';
    const ready = new Promise<void>((resolve, reject) => {
      el.addEventListener('de-ready', () => resolve(), { once: true });
      el.addEventListener('de-error', (ev) => reject(new Error(JSON.stringify(ev))), {
        once: true,
      });
    });
    el.backend = e.backend('ada', role, [e.regionRolesDocId]);
    el.setAttribute('doc-id', e.regionRolesDocId);
    document.getElementById('mount')!.append(el);
    await ready;
  }, role);
  await expect(page.locator(`${EL} .de-editing-surface`)).toBeVisible();
  await page.evaluate(() =>
    (
      window as unknown as {
        __embed: {
          internals(el: Element): { editor: { openPane(id: string): Promise<boolean> } };
        };
      }
    ).__embed
      .internals(document.querySelector('doc-editor[data-test="prm048"]')!)
      .editor.openPane('permissions'),
  );
}

test.describe('the region state in the permissions pane (PRM-048, criteria 3 to 5)', () => {
  test('an owner changes the state and the pane follows it without a reload', async ({ page }) => {
    await openEmbed(page);
    await mount(page, 'owner');
    const element = page.locator(EL);
    const row = element.locator('li[data-region]').first();
    await expect(row.locator('.de-badge')).toHaveText(/Draft/);
    const ready = (await events(page, 'de-ready')).length;

    await row.getByRole('button').click();
    const control = element.locator('[data-region-state]');
    await expect(control).toBeVisible();
    await control.getByRole('combobox', { name: 'State of the region' }).selectOption('approved');
    await control.getByRole('button', { name: 'Change state' }).click();

    // The backend's state is now approved, and the pane shows it, with no reload.
    await expect(row.locator('.de-badge')).toHaveText(/Approved/);
    await expect(row).toHaveAttribute('data-state', 'approved');
    await expect(row.locator('[data-region-editors]')).toHaveText(
      'It is approved, so nobody can edit it.',
    );
    expect((await events(page, 'de-ready')).length).toBe(ready);
    expect(await events(page, 'de-error')).toEqual([]);
    const stored = await page.evaluate(() => {
      const e = (
        window as unknown as {
          __embed: {
            regionRolesDocId: string;
            service: {
              document(id: string): { regions(): Array<{ state: string }> } | undefined;
            };
          };
        }
      ).__embed;
      return e.service.document(e.regionRolesDocId)!.regions()[0]!.state;
    });
    expect(stored).toBe('approved');
  });

  test('an editor has no state control', async ({ page }) => {
    await openEmbed(page);
    await mount(page, 'editor');
    const element = page.locator(EL);
    const row = element.locator('li[data-region]').first();
    await row.getByRole('button').click();
    await expect(element.locator('[data-region-state]')).toHaveCount(0);
    await expect(row.locator('.de-badge')).toHaveText(/Draft/);
  });

  test('a lease taken by someone else names the holder and its expiry, then goes', async ({
    page,
  }) => {
    await openEmbed(page);
    await mount(page, 'owner');
    const element = page.locator(EL);
    const row = element.locator('li[data-region]').first();
    await expect(row.locator('.de-badge')).toHaveText(/Draft/);
    const ready = (await events(page, 'de-ready')).length;

    const lease = (on: boolean) =>
      page.evaluate((on) => {
        const e = (
          window as unknown as {
            __embed: {
              regionRolesDocId: string;
              service: {
                now(): number;
                document(id: string): { regions(): Array<{ id: string }> } | undefined;
                setLeases(docId: string, leases: unknown[]): void;
              };
            };
          }
        ).__embed;
        const docId = e.regionRolesDocId;
        const region = e.service.document(docId)!.regions()[0]!.id;
        e.service.setLeases(
          docId,
          on ? [{ region, holder: 'bob', expiresAt: e.service.now() + 10 * 60_000 }] : [],
        );
      }, on);

    await lease(true);
    await expect(row.locator('[data-region-editors]')).toContainText(
      'is editing it at the moment. The lease expires ',
    );
    await lease(false);
    await expect(row.locator('[data-region-editors]')).not.toContainText('lease expires');
    expect((await events(page, 'de-ready')).length).toBe(ready);
  });
});
