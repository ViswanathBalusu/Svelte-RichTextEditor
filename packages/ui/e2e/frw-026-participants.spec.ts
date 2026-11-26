/**
 * The participants list alone (FRW-026), in the browser: a participant added with roles, a kind, an
 * order, a `sub` and a name; equal and ascending orders; a change and a removal; the refusals; the
 * read-only states; a list a host wrote that appears without the owner entering it; keyboard use
 * with visible focus; and axe. Run with
 * `DOCEDIT_UI_PORT=57435 pnpm exec playwright test -c packages/ui/playwright.config.ts packages/ui/e2e/frw-026-participants.spec.ts`.
 * The service's part (the workflow resource with `If-Match`, the guard and the refusal once sent) is
 * in packages/element/test/frw-026-participants.test.ts; here the harness records what would reach it.
 */
import { expect, test, type Page } from '@playwright/test';
import { axe } from './helpers.ts';

interface Recorded {
  saves: Array<{
    id?: string;
    name: string;
    sub: string;
    roles: string[];
    kind: string;
    order: number;
  }>;
  removes: string[];
  announced: string[];
}

const recorded = (page: Page): Promise<Recorded> =>
  page.evaluate(() => (window as unknown as { harness: Recorded }).harness);

test.describe('FRW-026 participants', () => {
  test('lists a participant with name, identifier, kind, roles and order, and no contact detail', async ({
    page,
  }) => {
    await page.goto('/participants.html');
    const item = page.locator('[data-participant="p1"]');
    await expect(item.locator('[data-participants="name"]')).toHaveText('Jane Doe');
    await expect(item.locator('[data-participants="order"]')).toHaveText('Order 1');
    await expect(item).toContainText('Identifier: u-jane');
    await expect(item).toContainText('Roles: Tenant');
    await expect(item).toContainText('signs');
    await expect(page.getByLabel(/e-?mail|phone|telephone/i)).toHaveCount(0);
  });

  test('adds a participant with roles, a kind, an order, a sub and a name, and saves it', async ({
    page,
  }) => {
    await page.goto('/participants.html');
    await page.getByRole('button', { name: 'Add participant' }).click();
    // The new participant is offered the order after everyone's.
    await expect(page.getByLabel('Order', { exact: true })).toHaveValue('2');
    await page.getByLabel('Name', { exact: true }).fill('Ola Landlord');
    await page.getByLabel('Identifier at the host').fill('host-user-9');
    await page.getByLabel('Landlord').check();
    await page.getByLabel('Role in the workflow', { exact: true }).selectOption('approver');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('[data-participants="form"]')).toHaveCount(0);
    const { saves, announced } = await recorded(page);
    expect(saves).toEqual([
      {
        name: 'Ola Landlord',
        sub: 'host-user-9',
        roles: ['role_landlord'],
        kind: 'approver',
        order: 2,
      },
    ]);
    expect(announced).toContain('announce.participants.saved');
    const added = page.locator('[data-participant="p2"]');
    await expect(added).toContainText('Ola Landlord');
    await expect(added).toContainText('approves');
  });

  test('two participants with the same order are shown together, a higher order after them', async ({
    page,
  }) => {
    await page.goto('/participants.html');
    await page.getByRole('button', { name: 'Add participant' }).click();
    await page.getByLabel('Name', { exact: true }).fill('Second');
    await page.getByLabel('Landlord').check();
    await page.getByLabel('Order', { exact: true }).fill('1');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('button', { name: 'Add participant' }).click();
    await page.getByLabel('Name', { exact: true }).fill('Third');
    await page.getByLabel('Tenant').check();
    await page.getByRole('button', { name: 'Save' }).click();
    const orders = await page
      .locator('[data-participant]')
      .evaluateAll((els) =>
        els.map((e) => [
          e.querySelector('[data-participants="name"]')?.textContent,
          e.getAttribute('data-order'),
        ]),
      );
    expect(orders).toEqual([
      ['Jane Doe', '1'],
      ['Second', '1'],
      ['Third', '2'],
    ]);
  });

  test('a person bound to two roles keeps both, and a role may have two people', async ({
    page,
  }) => {
    await page.goto('/participants.html');
    await page.getByRole('button', { name: 'Edit participant Jane Doe' }).click();
    await page.getByLabel('Landlord').check();
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('[data-participant="p1"]')).toContainText('Roles: Tenant, Landlord');
    expect((await recorded(page)).saves[0]).toMatchObject({
      id: 'p1',
      roles: ['role_tenant', 'role_landlord'],
    });
  });

  test('removes a participant', async ({ page }) => {
    await page.goto('/participants.html');
    await page.getByRole('button', { name: 'Remove Jane Doe' }).click();
    await expect(page.locator('[data-participants="empty"]')).toBeVisible();
    expect((await recorded(page)).removes).toEqual(['p1']);
  });

  test('refuses a form with no role, an order that is not a whole number, or no name, and sends nothing', async ({
    page,
  }) => {
    await page.goto('/participants.html');
    await page.getByRole('button', { name: 'Add participant' }).click();
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('alert')).toContainText('Give a name or an identifier.');
    await expect(page.getByLabel('Name', { exact: true })).toHaveAttribute('aria-invalid', 'true');
    await page.getByLabel('Name', { exact: true }).fill('Someone');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('alert')).toContainText('Choose at least one role.');
    await page.getByLabel('Tenant').check();
    await page.getByLabel('Order', { exact: true }).fill('1.5');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('alert')).toContainText('The order must be a whole number from 1.');
    expect((await recorded(page)).saves).toEqual([]);
  });

  test('says so when someone else changed the list first', async ({ page }) => {
    await page.goto('/participants.html?fail=stale');
    await page.getByRole('button', { name: 'Edit participant Jane Doe' }).click();
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('alert')).toContainText(
      'Someone else changed the participants first.',
    );
  });

  test('is read-only without manage: the list reads and nothing can be changed', async ({
    page,
  }) => {
    await page.goto('/participants.html?readOnly=1');
    await expect(page.locator('[data-participants="read-only"]')).toContainText(
      'needs permission to manage',
    );
    await expect(page.locator('[data-participant="p1"]')).toBeVisible();
    await expect(page.getByRole('button', { name: /Add participant|Edit|Remove/ })).toHaveCount(0);
    expect(await axe(page)).toEqual([]);
  });

  test('is read-only once the workflow is sent and says why', async ({ page }) => {
    await page.goto('/participants.html?sent=1');
    await expect(page.locator('[data-participants="read-only"]')).toContainText(
      'has been sent, so its participants can no longer be changed',
    );
    await expect(page.getByRole('button', { name: /Add participant|Edit|Remove/ })).toHaveCount(0);
  });

  test('shows people a host wrote through the API without the owner entering them', async ({
    page,
  }) => {
    await page.goto('/participants.html');
    await expect(page.locator('[data-participant]')).toHaveCount(1);
    await page.evaluate(() =>
      (
        window as unknown as { harness: { hostWrites: (list: unknown[]) => void } }
      ).harness.hostWrites([
        {
          id: 'h1',
          name: 'Ada Host',
          sub: 'host-7',
          roles: ['role_tenant'],
          kind: 'filler',
          order: 1,
          state: 'active',
        },
        {
          id: 'h2',
          name: null,
          sub: 'host-8',
          roles: ['role_landlord'],
          kind: 'signer',
          order: 2,
          state: 'pending',
        },
      ]),
    );
    await expect(page.locator('[data-participant]')).toHaveCount(2);
    await expect(page.locator('[data-participant="h1"]')).toContainText('Ada Host');
    await expect(page.locator('[data-participant="h1"]')).toContainText('State: active');
    // A person known only by the host's identifier is listed by it.
    await expect(page.locator('[data-participant="h2"] [data-participants="name"]')).toHaveText(
      'host-8',
    );
    expect((await recorded(page)).saves).toEqual([]);
  });

  test('is operable from the keyboard with visible focus, in order, and the form saves with Enter', async ({
    page,
  }) => {
    await page.goto('/participants.html');
    const add = page.getByRole('button', { name: 'Add participant' });
    await add.focus();
    await page.keyboard.press('Enter');
    // The name takes focus when the form opens.
    await expect(page.getByLabel('Name', { exact: true })).toBeFocused();
    await page.keyboard.type('Key Board');
    const order = ['Identifier at the host', 'Tenant', 'Landlord', 'Role in the workflow', 'Order'];
    for (const label of order) {
      await page.keyboard.press('Tab');
      const control = page.getByLabel(label, { exact: true });
      await expect(control).toBeFocused();
      const outline = await control.evaluate((el) => {
        const s = getComputedStyle(el);
        return { style: s.outlineStyle, width: parseFloat(s.outlineWidth), shadow: s.boxShadow };
      });
      expect(
        (outline.style !== 'none' && outline.width > 0) || outline.shadow !== 'none',
        `${label} shows its focus`,
      ).toBe(true);
    }
    await page.getByLabel('Tenant').check();
    await page.getByLabel('Order', { exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-participants="form"]')).toHaveCount(0);
    expect((await recorded(page)).saves[0]).toMatchObject({
      name: 'Key Board',
      roles: ['role_tenant'],
    });
  });

  test('axe finds no violation in the list or in the open form', async ({ page }) => {
    await page.goto('/participants.html');
    expect(await axe(page)).toEqual([]);
    await page.getByRole('button', { name: 'Edit participant Jane Doe' }).click();
    expect(await axe(page)).toEqual([]);
  });
});
