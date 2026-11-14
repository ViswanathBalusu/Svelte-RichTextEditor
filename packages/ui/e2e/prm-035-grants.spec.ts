/**
 * Grants on a region from the permissions pane, criteria 6 and 7 of PRM-035 (lane U-PRM-035-051):
 * each role carries a colour, a shape and a text label, and a person who only uses the keyboard
 * can add, change and remove a grant, with each result announced in the shell's status region
 * (each announcement is counted, so a check can pass only because of the step before it).
 * Run with `pnpm exec playwright test -c packages/ui/playwright.config.ts packages/ui/e2e/prm-035-grants.spec.ts`
 * (Chromium, Firefox and WebKit; set DOCEDIT_UI_PORT to a free port in 56500 to 56509).
 */
import type { RegionRole } from '../src/core-api.ts';
import { expect, open, test } from './helpers.ts';

const REGIONS = [
  {
    id: 'r1',
    title: 'Terms',
    policy: 'restricted' as const,
    order: 0,
    state: 'draft' as const,
    editors: { roles: ['owner'], principals: ['user:u1', 'group:legal'] },
  },
];
const READER = {
  rev: 3,
  docRole: 'editor',
  caps: ['view', 'comment', 'suggest', 'edit', 'structure'],
  scopes: {
    body: ['view', 'comment', 'suggest', 'edit'],
    'region:r1': ['view', 'comment', 'suggest', 'edit'],
  },
};
const OWNER = { ...READER, docRole: 'owner', caps: [...READER.caps, 'manage'] };

const ROLE_PRINCIPALS: ReadonlyArray<readonly [RegionRole, string]> = [
  ['viewer', 'user:u1'],
  ['commenter', 'user:u9'],
  ['suggester', 'group:legal'],
  ['editor', 'user:u7'],
];

test.describe('grants on a region, keyboard and roles (PRM-035, criteria 6 and 7)', () => {
  test('each role has its own colour, its own shape and a text label (criterion 6)', async ({
    page,
  }) => {
    const h = await open(page, {
      extended: true,
      regions: REGIONS,
      permissions: OWNER,
      grants: ROLE_PRINCIPALS.map(([role, principal]) => ({ region: 'r1', principal, role })),
    });
    await h.exec('view.permissions');
    const pane = page.locator('.de-pane[data-pane="permissions"]');
    await pane.locator('[data-region="r1"]').getByRole('button').click();

    const signatures: Array<{ role: string; color: string; radius: string; transform: string }> =
      [];
    for (const [role, principal] of ROLE_PRINCIPALS) {
      const grant = pane.locator(`.de-grant[data-principal="${principal}"]`);
      // The text label is the role's name, read by assistive technology (the mark is aria-hidden).
      await expect(grant.locator('.de-role')).toContainText(new RegExp(role, 'i'));
      const mark = grant.locator('.de-role-mark');
      await expect(mark).toHaveAttribute('data-role', role);
      const style = await mark.evaluate((el) => {
        const s = getComputedStyle(el);
        return { color: s.color, radius: s.borderRadius, transform: s.transform };
      });
      signatures.push({ role, ...style });
    }

    // Four different colours, four different shapes (the shape is the icon, drawn by the CSS).
    expect(new Set(signatures.map((s) => s.color)).size).toBe(4);
    expect(new Set(signatures.map((s) => `${s.radius}|${s.transform}`)).size).toBe(4);
    for (const s of signatures) {
      expect(s.color, `${s.role} has a colour`).not.toBe('rgba(0, 0, 0, 0)');
    }
  });

  test('a keyboard-only user adds, changes and removes a grant, and each result is announced (criterion 7)', async ({
    page,
  }) => {
    const h = await open(page, {
      extended: true,
      regions: REGIONS,
      permissions: OWNER,
      grants: [{ region: 'r1', principal: 'user:u1', role: 'editor' }],
    });
    await h.exec('view.permissions');
    const pane = page.locator('.de-pane[data-pane="permissions"]');
    const regionButton = pane.locator('[data-region="r1"]').getByRole('button');
    await regionButton.focus();
    await page.keyboard.press('Enter');

    // Find the group with the search field, choose it with the arrow keys and Enter.
    const search = pane.getByRole('combobox', { name: 'Find a person or group' });
    await search.focus();
    await page.keyboard.type('Legal');
    const options = pane
      .getByRole('listbox', { name: 'People and groups found' })
      .getByRole('option');
    await expect(options).toHaveCount(1);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(search).toHaveValue('Legal team');

    // The role: from the default editor, two steps up the list give commenter.
    const role = pane.getByRole('combobox', { name: 'Role' });
    await role.focus();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await expect(role).toHaveValue('commenter');

    // Every message the shell's status region carries from here on, recorded as it is set. The
    // shell clears the region before each message (`say` in App.svelte), so the same words said
    // twice are two entries; the count of "Permissions saved." is the count of saves announced.
    const status = page.locator('.de-shell > [role="status"]');
    await page.evaluate(() => {
      const region = document
        .getElementById('host')!
        .shadowRoot!.querySelector('.de-shell > [role="status"]')!;
      const said: string[] = [];
      Object.assign(window, { __prm035Said: said });
      new MutationObserver(() => {
        const text = region.textContent?.trim() ?? '';
        if (text) said.push(text);
      }).observe(region, { childList: true, characterData: true, subtree: true });
    });
    const savedAnnouncements = () =>
      page.evaluate(
        () =>
          (window as unknown as { __prm035Said: string[] }).__prm035Said.filter(
            (t) => t === 'Permissions saved.',
          ).length,
      );
    expect(await savedAnnouncements()).toBe(0);

    // Save with the keyboard: the button is reached and activated without a pointer.
    const save = pane.getByRole('button', { name: 'Save' });
    await save.focus();
    await page.keyboard.press('Enter');
    await expect(pane.locator('[data-status="permissions"]')).toHaveText('Permissions saved.');
    await expect(status).toHaveText('Permissions saved.');
    await expect.poll(savedAnnouncements).toBe(1);
    await expect(pane.locator('.de-grant[data-principal="group:legal"]')).toContainText(
      'Legal team',
    );
    const saved = await h.grantSaves();
    expect(saved).toHaveLength(1);
    expect(saved[0]!.grants).toEqual([
      { region: 'r1', principal: 'user:u1', role: 'editor' },
      { region: 'r1', principal: 'group:legal', role: 'commenter' },
    ]);

    // Change Ada's existing grant from editor to suggester: choose her again, set the new role and
    // save. Her grant is replaced, not added a second time, and the change is announced.
    await search.focus();
    await page.keyboard.type('Ada');
    await expect(options).toHaveCount(1);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(search).toHaveValue('Ada Lovelace');
    await role.focus();
    await expect(role).toHaveValue('commenter');
    await page.keyboard.press('ArrowDown');
    await expect(role).toHaveValue('suggester');
    await save.focus();
    await page.keyboard.press('Enter');
    await expect.poll(savedAnnouncements).toBe(2);
    const ada = pane.locator('.de-grant[data-principal="user:u1"]');
    await expect(ada).toHaveCount(1);
    await expect(ada.locator('.de-role')).toHaveAttribute('data-role', 'suggester');
    await expect(ada.locator('.de-role')).toContainText('Suggester');
    const afterChange = await h.grantSaves();
    expect(afterChange).toHaveLength(2);
    expect(afterChange[1]!.grants).toEqual([
      { region: 'r1', principal: 'group:legal', role: 'commenter' },
      { region: 'r1', principal: 'user:u1', role: 'suggester' },
    ]);

    // Remove Ada's grant with the keyboard. The count of announcements goes up by one only
    // because of the removal: the region's text was already "Permissions saved." before it.
    const remove = pane.getByRole('button', { name: 'Remove the role of Ada Lovelace' });
    await remove.focus();
    await page.keyboard.press('Enter');
    await expect(ada).toHaveCount(0);
    await expect.poll(savedAnnouncements).toBe(3);
    await expect(status).toHaveText('Permissions saved.');
    const afterRemove = await h.grantSaves();
    expect(afterRemove).toHaveLength(3);
    expect(afterRemove[2]!.grants).toEqual([
      { region: 'r1', principal: 'group:legal', role: 'commenter' },
    ]);
  });
});
