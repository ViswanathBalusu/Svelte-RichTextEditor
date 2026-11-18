/**
 * FRW-012 criterion 4 (lane w4): in the real element, the grants pane offers the document's role
 * placeholders beside users and groups. The document has a region and two roles (Tenant and
 * Landlord; `regionRolesDocId` of the embed page). An owner opens the permissions pane, types part
 * of a role's name in "Find a person or group" and finds the role in the same list as the people and
 * groups the host's directory returns, each saying what it is. The owner chooses the role, gives it
 * the editor role and saves, and the grant the backend then holds names the principal `role:<id>`.
 * The host's directory is asked for users and groups only, never for roles.
 *
 * Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts e2e/frw-012-role-grant.spec.ts`.
 */
import { expect, test } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';
import { FIELD_IDS, editorOf } from './frw-helpers.ts';

const EL = editorOf('one');

test('the grants pane offers a role placeholder beside users and groups, and saves a grant to it (criterion 4)', async ({
  page,
}) => {
  await openEmbed(page);
  await page.evaluate(async () => {
    const e = (window as unknown as { __embed: Record<string, unknown> }).__embed as unknown as {
      backend(sub: string, role: string, docs: string[]): unknown;
      regionRolesDocId: string;
    };
    const el = document.createElement('doc-editor') as HTMLElement & {
      backend: unknown;
      searchPrincipals: unknown;
    };
    el.dataset['test'] = 'one';
    const asked: unknown[] = [];
    (window as unknown as { asked: unknown[] }).asked = asked;
    el.searchPrincipals = async (query: unknown) => {
      asked.push(query);
      return [
        { principal: 'user:bob', name: 'Landon Bob' },
        { principal: 'group:landlords', name: 'Land owners' },
      ];
    };
    const ready = new Promise<void>((resolve, reject) => {
      el.addEventListener('de-ready', () => resolve(), { once: true });
      el.addEventListener('de-error', (ev) => reject(new Error(JSON.stringify(ev))), {
        once: true,
      });
    });
    el.backend = e.backend('ada', 'owner', [e.regionRolesDocId]);
    el.setAttribute('doc-id', e.regionRolesDocId);
    document.getElementById('mount')!.append(el);
    await ready;
  });
  await expect(page.locator(`${EL} .de-editing-surface`)).toBeVisible();

  await page.evaluate(() =>
    (
      window as unknown as {
        __embed: {
          internals(el: Element): { editor: { openPane(id: string): Promise<boolean> } };
        };
      }
    ).__embed
      .internals(document.querySelector('doc-editor[data-test="one"]')!)
      .editor.openPane('permissions'),
  );
  const element = page.locator(EL);
  await element.getByRole('button', { name: /^Middle\b/ }).click();
  const search = element.getByRole('combobox', { name: 'Find a person or group' });
  await search.fill('Land');

  // The host's answer and the role are in the same list, and each says what it is.
  const options = element.getByRole('listbox').getByRole('option');
  await expect(options).toHaveCount(3);
  await expect(options.filter({ hasText: 'Landon Bob' })).toContainText('Person');
  await expect(options.filter({ hasText: 'Land owners' })).toContainText('Group');
  const roleOption = element.locator('[role="option"][data-principal^="role:"]');
  await expect(roleOption).toHaveCount(1);
  await expect(roleOption).toHaveAttribute('data-principal', `role:${FIELD_IDS.landlord}`);
  await expect(roleOption).toContainText('Landlord');
  await expect(roleOption).toContainText('Workflow role');
  // Roles are found among the document's own, so the host is asked for users and groups only.
  const asked = await page.evaluate(() => (window as unknown as { asked: unknown[] }).asked);
  expect(asked).toHaveLength(1);
  expect(asked[0]).toMatchObject({ text: 'Land', purpose: 'grant', kinds: ['user', 'group'] });

  await roleOption.click();
  await expect(search).toHaveValue('Landlord');
  await element.getByRole('combobox', { name: 'Role' }).selectOption('editor');
  await element.getByRole('button', { name: 'Save' }).click();
  await expect(element.locator('[data-status="permissions"]')).toHaveText('Permissions saved.');

  // The grant is listed by the role's name, and the backend holds it under the principal `role:<id>`.
  const principal = `role:${FIELD_IDS.landlord}`;
  await expect(element.locator(`.de-grant[data-principal="${principal}"]`)).toContainText(
    'Landlord',
  );
  const saved = await page.evaluate(() => {
    const e = (
      window as unknown as {
        __embed: {
          regionRolesDocId: string;
          service: {
            document(id: string): { grants(): { value: { grants: unknown[] } } } | undefined;
          };
        };
      }
    ).__embed;
    return e.service.document(e.regionRolesDocId)!.grants().value.grants;
  });
  expect(saved).toEqual([expect.objectContaining({ principal, role: 'editor' })]);
});
