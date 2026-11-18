/**
 * FRW-074 (lane w4): the roles manager in the real element, with the shell, the core and the
 * in-memory backend of the embed page. An editor adds, renames, recolours and deletes roles, and
 * each change is read back from the confirmed document (the content the service acknowledged), so
 * it went through the log. A role fields are assigned to is not deleted, and the pane lists those
 * fields. A commenter sees the roles and has no control that changes one. A participant in the
 * fill mode sees each role with its shape and name in the field markers and the legend.
 *
 * Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts e2e/frw-074-roles-manager.spec.ts`.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';
import {
  FIELD_IDS,
  confirmed,
  editorOf,
  mountFields,
  nodes,
  openPaneBySearch,
} from './frw-helpers.ts';

const roleDefs = async (page: Page, name: string): Promise<string[]> =>
  nodes(await confirmed(page, name), 'role_def').map(
    (n) => `${String(n.attrs?.['id'])}|${String(n.attrs?.['name'])}|${String(n.attrs?.['color'])}`,
  );

/** Each role the list shows: its shape, the colour of the shape, the name and the shape's name. */
async function shown(list: Locator): Promise<Array<{ icon: string; name: string; shape: string }>> {
  return list.locator('> li').evaluateAll((items) =>
    items.map((li) => ({
      icon: li.querySelector('.de-role-icon')?.getAttribute('data-icon') ?? '',
      name: li.querySelector('[data-content]')?.textContent?.trim() ?? '',
      shape: li.querySelector('[data-roles="shape"]')?.textContent?.trim() ?? '',
    })),
  );
}

test.describe('FRW-074 the roles manager', () => {
  test('an editor adds, renames, recolours and deletes roles through the log; a role in use is kept', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountFields(page, { name: 'one', sub: 'bob', role: 'editor' });
    const pane = await openPaneBySearch(page, 'one', 'Roles', 'roles');
    const list = pane.locator('[data-roles="list"]');

    // Criterion 2: each role has its colour on a shape, its name as text and the shape named.
    expect(await shown(list)).toEqual([
      { icon: 'circle', name: 'Tenant', shape: 'Shape: circle' },
      { icon: 'square', name: 'Landlord', shape: 'Shape: square' },
    ]);
    await expect(list.locator('[data-role="role_tenant"] [data-roles="count"]')).toHaveText(
      '3 fields are assigned to this role.',
    );

    // Criterion 1, create: an empty name is refused and nothing is committed.
    await pane.locator('[data-roles="add"]').click();
    await expect(pane.getByLabel('Name')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(pane.locator('[data-roles="error"]')).toHaveText(
      'Some values are not valid. Check the marked fields.',
    );
    await expect(pane.getByLabel('Name')).toHaveAttribute('aria-invalid', 'true');
    expect(await roleDefs(page, 'one')).toHaveLength(2);

    // With a name it is committed as a role_def after the others, by the keyboard alone.
    await page.keyboard.type('Witness');
    await pane.getByLabel('Colour').fill('#2ca02c');
    await pane.getByLabel('Name').press('Enter');
    await expect
      .poll(() => roleDefs(page, 'one'))
      .toEqual([
        'role_tenant|Tenant|#1F77B4',
        'role_landlord|Landlord|#FF7F0E',
        'role_1|Witness|#2CA02C',
      ]);
    expect((await shown(list)).at(-1)).toEqual({
      icon: 'triangle',
      name: 'Witness',
      shape: 'Shape: triangle',
    });
    // The three shapes differ: no role is told apart by colour alone.
    expect(new Set((await shown(list)).map((r) => r.icon)).size).toBe(3);

    // Rename and recolour: one role_def changes; the fields still name it.
    await pane.getByRole('button', { name: 'Edit role Tenant' }).click();
    await pane.getByLabel('Name').fill('Lessee');
    await pane.getByLabel('Colour').fill('#aa00aa');
    await pane.locator('[data-roles="save"]').click();
    await expect.poll(() => roleDefs(page, 'one')).toContain('role_tenant|Lessee|#AA00AA');
    await expect(list.locator('[data-role="role_tenant"] [data-content]').first()).toHaveText(
      'Lessee',
    );
    const colour = await list
      .locator('[data-role="role_tenant"] .de-role-icon')
      .evaluate((el) => getComputedStyle(el).color);
    expect(colour).toBe('rgb(170, 0, 170)');
    const fields = nodes(await confirmed(page, 'one'), 'form_field');
    expect(fields.filter((f) => f.attrs?.['assignee'] === 'role_tenant')).toHaveLength(3);

    // Delete a role in use: refused, the references are listed, the definition stays (I13).
    await pane.getByRole('button', { name: 'Delete Landlord' }).click();
    const inUse = list.locator('[data-role="role_landlord"] [data-roles="in-use"]');
    await expect(inUse).toContainText('Fields are still assigned to this role');
    await expect(inUse.locator(`li[data-field="${FIELD_IDS.landlordName}"]`)).toHaveText(
      'Landlord',
    );
    expect(await roleDefs(page, 'one')).toHaveLength(3);

    // Delete a role no field names: the role_def goes.
    await pane.getByRole('button', { name: 'Delete Witness' }).click();
    await expect.poll(async () => (await roleDefs(page, 'one')).length).toBe(2);
    await expect(list.locator('[data-role="role_1"]')).toHaveCount(0);

    const axe = await new AxeBuilder({ page })
      .include({ fromShadowDom: [editorOf('one'), '.de-pane[data-pane="roles"]'] })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(axe.violations.map((v) => v.id)).toEqual([]);
  });

  test('a user without structure sees the roles and has no control that changes one', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountFields(page, { name: 'one', sub: 'vic', role: 'commenter' });
    // The document is read-only for a commenter, so the pane is opened as its command opens it.
    const opened = await page.evaluate(() => {
      const e = (
        window as unknown as {
          __embed: {
            internals(el: Element): { editor: { openPane(id: string): Promise<boolean> } };
          };
        }
      ).__embed;
      const el = document.querySelector('doc-editor[data-test="one"]')!;
      return e.internals(el).editor.openPane('roles');
    });
    expect(opened).toBe(true);
    const pane = page.locator(`${editorOf('one')} .de-pane[data-pane="roles"]`);
    await expect(pane).toBeVisible();
    await expect(pane.locator('[data-roles="read-only"]')).toHaveText(
      'Changing the roles needs permission to change the structure of the document.',
    );
    expect(await shown(pane.locator('[data-roles="list"]'))).toEqual([
      { icon: 'circle', name: 'Tenant', shape: 'Shape: circle' },
      { icon: 'square', name: 'Landlord', shape: 'Shape: square' },
    ]);
    // Nothing in the manager can be activated: no button, no form control.
    const manager = pane.locator('.de-roles');
    await expect(manager.getByRole('button')).toHaveCount(0);
    await expect(manager.locator('input, select, textarea')).toHaveCount(0);
  });

  test('field markers and the legend of the fill pane show each role by shape and name', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountFields(page, { name: 'fill', sub: 'vic', fill: true });
    const editor = editorOf('fill');
    await page
      .locator(`${editor} .de-fill-bar`)
      .getByRole('button', { name: 'What is left' })
      .click();
    const pane = page.locator(`${editor} .de-pane[data-pane="fill"]`);
    await expect(pane).toBeVisible();

    // The marker of a field: the role's shape in its colour, and the role's name in the name.
    const mine = pane.locator(`[data-field-row="${FIELD_IDS.name}"]`);
    await expect(mine.locator('.de-role-icon')).toHaveAttribute('data-icon', 'circle');
    await expect(mine.getByRole('button')).toHaveAccessibleName('Name, Tenant, yours to fill in');
    const other = pane.locator(`[data-field-row="${FIELD_IDS.landlordName}"]`);
    await expect(other.locator('.de-role-icon')).toHaveAttribute('data-icon', 'square');
    await expect(other.locator('[data-marker]')).toHaveText('Landlord');

    // The legend: each role once, shape and name.
    const legend = await pane.locator('.de-role-legend > li').evaluateAll((items) =>
      items.map((li) => ({
        icon: li.querySelector('.de-role-icon')?.getAttribute('data-icon'),
        name: li.querySelector('[data-content]')?.textContent?.trim(),
      })),
    );
    expect(legend).toEqual([
      { icon: 'circle', name: 'Tenant' },
      { icon: 'square', name: 'Landlord' },
    ]);
  });
});
