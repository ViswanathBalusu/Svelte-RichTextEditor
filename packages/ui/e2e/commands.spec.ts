/**
 * Command surfaces of phase 1b, all read from the one registry (13 §4): a host-built toolbar
 * (UX-005), the full toolbar with task and contextual groups (UX-007), the context menu (UX-008),
 * the format painter (UX-009) and the keyboard shortcuts with their table and reference (UX-013).
 */
import { expect, focusSurface, focused, open, test } from './helpers.ts';

const VIEW_ONLY = { scope: 'body', caps: ['view'], limit: 'role' } as const;
const EDIT = { scope: 'body', caps: ['view', 'comment', 'suggest', 'edit'], limit: null } as const;

test.describe('a host-built toolbar (UX-005)', () => {
  test('with toolbar="none" there is no built-in toolbar; page, panes and status bar work', async ({
    page,
  }) => {
    const h = await open(page, { toolbar: 'none', hostToolbar: true });
    await expect(page.locator('.de-shell [role="toolbar"]')).toHaveCount(0);
    await expect(page.locator('.de-status')).toBeVisible();
    await focusSurface(page);
    await page.keyboard.type('x');
    expect(await h.exec('view.outline')).toEqual({ ran: true, reason: null });
    await expect(page.locator('.de-pane[data-pane="outline"]')).toBeVisible();
  });

  test('the host toolbar agrees with the registry over a sequence of selections', async ({
    page,
  }) => {
    const h = await open(page, { hostToolbar: true });
    const hostBold = page.locator('#host-toolbar [data-command="format.bold"]');
    const builtIn = page.locator('.de-toolbar [data-command-id="format.bold"]');
    const steps = [
      async () => h.setSelection({ marks: ['bold'] }),
      async () => h.setSelection({ marks: [] }),
      async () => h.setAccess(VIEW_ONLY),
      async () => h.setAccess(EDIT),
      async () => h.setSelection({ marks: ['bold', 'italic'] }),
    ];
    for (const step of steps) {
      await step();
      await h.frames(2);
      const state = await h.state('format.bold');
      await expect(hostBold).toHaveAttribute('aria-pressed', String(state.active));
      await expect(hostBold).toHaveAttribute('aria-disabled', String(!state.enabled));
      await expect(builtIn).toHaveAttribute('aria-pressed', String(state.active));
      if (state.enabled) await expect(builtIn).not.toHaveAttribute('aria-disabled');
      else await expect(builtIn).toHaveAttribute('aria-disabled', 'true');
    }
    // de-command-state listed only the commands that changed, so the host did not poll.
    const events = await h.hostEvents();
    expect(events.filter((e) => e[0] !== 'exec').every((ids) => ids.length > 0)).toBe(true);
    expect(events.some((ids) => ids.includes('format.bold'))).toBe(true);
    expect(events.some((ids) => ids.length > 0 && !ids.includes('edit.selectAll'))).toBe(true);
  });

  test('exec from the host runs the same path; refused and unknown commands say why', async ({
    page,
  }) => {
    const h = await open(page, { hostToolbar: true });
    await page.locator('#host-toolbar [data-command="format.bold"]').click();
    expect(await h.runs()).toEqual(['bold']);
    await h.setAccess(VIEW_ONLY);
    await h.frames(2);
    await page.locator('#host-toolbar [data-command="format.bold"]').click({ force: true });
    expect(await h.runs()).toEqual(['bold']);
    expect(await h.exec('format.sparkle')).toEqual({ ran: false, reason: 'unknown' });
    expect(await h.exec('format.bold')).toEqual({ ran: false, reason: 'no-access' });
    expect((await h.hostEvents()).filter((e) => e[0] === 'exec').map((e) => e[2])).toEqual([
      JSON.stringify({ ran: true, reason: null }),
      JSON.stringify({ ran: false, reason: 'no-access' }),
    ]);
  });
});

test.describe('the full toolbar (UX-007)', () => {
  test('groups commands by task, each in the one group its entry names', async ({ page }) => {
    const h = await open(page, { toolbar: 'full', extended: true, styles: [] });
    const tabs = page.getByRole('tablist', { name: 'Command groups' });
    await expect(tabs.getByRole('tab')).toHaveText([
      'Edit',
      'Format',
      'Insert',
      'Page',
      'Review',
      'View',
    ]);
    const seen = new Map<string, string>();
    for (const tab of await tabs.getByRole('tab').all()) {
      await tab.click();
      const group = (await tab.getAttribute('data-group'))!;
      const panel = page.getByRole('tabpanel');
      await expect(panel).toHaveAttribute('data-group', group);
      for (const id of await panel
        .locator('[data-command-id]:not([data-command-id="toolbar.more"])')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-command-id')!))) {
        expect(seen.has(id), `${id} in two groups`).toBe(false);
        seen.set(id, group);
        expect(
          id.startsWith(`${group}.`) || group === 'review' || group === 'page' || group === 'view',
        ).toBe(true);
      }
    }
    // Every toolbar command of the registry is in exactly one group.
    expect(seen.get('format.bold')).toBe('format');
    expect(seen.get('format.painter')).toBe('format');
    expect(seen.get('insert.field.text')).toBe('insert');
    expect(seen.get('view.outline')).toBe('view');
    // The same entries as the compact layout.
    await h.setSettings({ toolbar: 'compact' });
    const compact = await page
      .locator('.de-toolbar [data-command-id]:not([data-command-id="toolbar.more"])')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-command-id')!));
    expect(new Set(compact)).toEqual(new Set(seen.keys()));
  });

  test('follows the tabs pattern and names every tab and group', async ({ page }) => {
    await open(page, { toolbar: 'full' });
    const first = page.getByRole('tab', { name: 'Edit' });
    await first.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Format' })).toBeFocused();
    await expect(page.getByRole('tab', { name: 'Format' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByRole('toolbar', { name: 'Format commands' })).toBeVisible();
    await page.keyboard.press('End');
    await expect(page.getByRole('tab').last()).toBeFocused();
    await page.keyboard.press('Home');
    await expect(first).toBeFocused();
    // Tab goes into the group's commands, which are one tab stop.
    await page.keyboard.press('Tab');
    expect((await focused(page)).command).toBe('edit.undo');
    await page.keyboard.press('ArrowRight');
    expect((await focused(page)).command).toBe('edit.redo');
    await page.keyboard.press('Escape');
    expect((await focused(page)).className).toContain('de-editing-surface');
  });

  test('shows a contextual group while the selection is in its object, without moving focus', async ({
    page,
  }) => {
    const h = await open(page, { toolbar: 'full' });
    await h.register('table.sample', 'command.format.bold', false, { group: 'table' });
    await focusSurface(page);
    await expect(page.getByRole('tab', { name: 'Table' })).toHaveCount(0);
    await h.setPanel('story');
    await h.setSelection({ contexts: ['story', 'table'] });
    await expect(page.getByRole('tab', { name: 'Header and footer' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Table' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Table' })).toHaveAttribute('data-contextual', '');
    expect((await focused(page)).className).toContain('de-editing-surface');
    await page.getByRole('tab', { name: 'Header and footer' }).click();
    await expect(
      page.getByRole('tabpanel').locator('[data-command-id="page.closeStory"]'),
    ).toBeVisible();
    await focusSurface(page);
    await h.setSelection({ contexts: [] });
    await expect(page.getByRole('tab', { name: 'Table' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Header and footer' })).toHaveCount(0);
    expect((await focused(page)).className).toContain('de-editing-surface');
    // The group shown falls back to the first one.
    await expect(page.getByRole('tab', { name: 'Edit' })).toHaveAttribute('aria-selected', 'true');
  });

  test('switches layout with the document untouched', async ({ page }) => {
    const h = await open(page);
    await h.setSelection({ empty: false, marks: ['italic'] });
    const before = await h.selection();
    await page.evaluate(() => {
      const surface = document
        .getElementById('host')!
        .shadowRoot!.querySelector('.de-editing-surface')!;
      (surface as HTMLElement).dataset['mark'] = 'same';
    });
    await h.setSettings({ toolbar: 'full' });
    await expect(page.getByRole('tablist')).toBeVisible();
    await h.setSettings({ toolbar: 'compact' });
    await expect(page.getByRole('toolbar', { name: 'Editing' })).toBeVisible();
    expect(await h.selection()).toEqual(before);
    expect((await h.calls()).filter((c) => c === 'mountBody')).toHaveLength(1);
    await expect(page.locator('.de-editing-surface')).toHaveAttribute('data-mark', 'same');
  });

  test('offers only the views the build supports', async ({ page }) => {
    await open(page, { toolbar: 'full', extended: true });
    await page.getByRole('tab', { name: 'View', exact: true }).click();
    const panel = page.getByRole('tabpanel');
    await expect(panel.locator('[data-command-id^="view.layout."]')).toHaveText(['Web layout']);
    const h = await open(page, { toolbar: 'full', extended: true, views: ['web', 'read'] });
    await page.getByRole('tab', { name: 'View', exact: true }).click();
    await expect(
      page.getByRole('tabpanel').locator('[data-command-id^="view.layout."]'),
    ).toHaveText(['Web layout', 'Reading']);
    await page.getByRole('tabpanel').locator('[data-command-id="view.layout.read"]').click();
    expect(await h.callsOf('setView')).toEqual([['read']]);
    await expect(page.locator('[data-command-id="view.layout.read"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

test.describe('the context menu (UX-008)', () => {
  test('opens at the pointer with the commands for text, by keyboard too', async ({ page }) => {
    const h = await open(page, { extended: true });
    const surface = page.locator('.de-editing-surface');
    const box = (await surface.boundingBox())!;
    await surface.click({ button: 'right', position: { x: 30, y: 10 } });
    const menu = page.getByRole('menu', { name: 'Commands for the selection' });
    await expect(menu).toBeVisible();
    const items = await menu
      .locator('[data-menu-item]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-command-id')));
    expect(items).toEqual(
      expect.arrayContaining(['format.bold', 'format.italic', 'insert.footnote', 'format.painter']),
    );
    expect(items).not.toContain('view.comments');
    const where = (await menu.boundingBox())!;
    expect(Math.abs(where.x - (box.x + 30))).toBeLessThan(3);
    expect(Math.abs(where.y - (box.y + 10))).toBeLessThan(3);
    // Keyboard: the first item has focus; arrows move; Escape closes and returns to the text.
    expect((await focused(page)).command).toBe(items[0]);
    await page.keyboard.press('ArrowDown');
    expect((await focused(page)).command).toBe(items[1]);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    expect((await focused(page)).className).toContain('de-editing-surface');
    // Shift+F10 opens it at the caret.
    await page.keyboard.press('Shift+F10');
    await expect(menu).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(menu).toHaveCount(0);
    expect((await h.runs()).length + (await h.named()).length).toBeGreaterThan(0);
    // With Shift held, the browser keeps its own menu.
    await surface.click({ button: 'right', modifiers: ['Shift'] });
    await expect(menu).toHaveCount(0);
  });

  test('lists a command the permissions do not allow as disabled, with the reason', async ({
    page,
  }) => {
    await open(page, { access: VIEW_ONLY });
    await page.locator('.de-editing-surface').click({ button: 'right' });
    const bold = page.getByRole('menu').locator('[data-command-id="format.bold"]');
    await expect(bold).toHaveAttribute('aria-disabled', 'true');
    await expect(bold).toHaveAccessibleDescription(
      'You can view this part of the document but not change it.',
    );
    await expect(bold).toHaveAccessibleName('Bold');
  });

  test('shows the items a command declares for the target, also one registered later', async ({
    page,
  }) => {
    const h = await open(page);
    await h.register('ext.tableTool', 'command.format.bold', false, { contextMenu: ['table'] });
    await page.locator('.de-editing-surface').click({ button: 'right' });
    await expect(page.getByRole('menu').locator('[data-command-id="ext.tableTool"]')).toHaveCount(
      0,
    );
    await page.keyboard.press('Escape');
    await h.setSelection({ contexts: ['table'] });
    await h.frames(2);
    await page.locator('.de-editing-surface').click({ button: 'right' });
    await expect(page.getByRole('menu').locator('[data-command-id="ext.tableTool"]')).toBeVisible();
  });
});

test.describe('the format painter (UX-009)', () => {
  test('arms, applies to the next selection by keyboard, and says what it does', async ({
    page,
  }) => {
    const h = await open(page, { extended: true });
    const live = page.locator('.de-shell > [role="status"]');
    await h.setSelection({ empty: false, marks: ['bold', 'italic'] });
    await focusSurface(page);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+C' : 'Control+Shift+C');
    const button = page.locator('.de-toolbar [data-command-id="format.painter"]');
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect(live).toHaveText(/Format painter on/);
    // The target: another selection, with its own content; Enter applies the formatting.
    await h.setSelection({ empty: false, marks: [] });
    await page.keyboard.press('Enter');
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    await expect(live).toHaveText('Formatting applied.');
    expect((await h.selection()).marks).toEqual(['bold', 'italic']);
    expect((await h.named()).map((n) => n[0])).toEqual(['copyFormat', 'pasteFormat']);
  });

  test('Escape turns it off without a change; a pointer selection applies it', async ({ page }) => {
    const h = await open(page, { extended: true });
    await h.setSelection({ empty: false, marks: ['bold'] });
    const button = page.locator('.de-toolbar [data-command-id="format.painter"]');
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await focusSurface(page);
    await page.keyboard.press('Escape');
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    expect((await h.named()).map((n) => n[0])).toEqual(['copyFormat']);
    await button.click();
    await h.setSelection({ empty: false, marks: [] });
    await page.locator('.de-editing-surface').click();
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    expect((await h.named()).map((n) => n[0])).toEqual(['copyFormat', 'copyFormat', 'pasteFormat']);
  });

  test('changes nothing where the user may not edit, and says why', async ({ page }) => {
    const h = await open(page, { extended: true });
    await h.setSelection({ empty: false, marks: ['bold'] });
    await page.locator('.de-toolbar [data-command-id="format.painter"]').click();
    await h.moveTo(
      { scope: 'region:r1', caps: ['view', 'comment'], limit: 'region' },
      { empty: false, marks: [] },
    );
    await focusSurface(page);
    await page.keyboard.press('Enter');
    await expect(page.locator('.de-shell > [role="status"]')).toHaveText(
      'You have no permission to change this part of the document.',
    );
    expect((await h.named()).map((n) => n[0])).toEqual(['copyFormat']);
    expect((await h.selection()).marks).toEqual([]);
  });
});

test.describe('keyboard shortcuts from the registry (UX-013)', () => {
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

  test('every shortcut and alternative of the table works with focus in the text', async ({
    page,
  }) => {
    const h = await open(page, { extended: true });
    await h.setUndo(2, 1);
    await focusSurface(page);
    await page.keyboard.press(`${mod}+b`);
    await page.keyboard.press(`${mod}+i`);
    await page.keyboard.press(`${mod}+z`);
    await page.keyboard.press(`${mod}+y`);
    await page.keyboard.press(`${mod}+Shift+z`);
    await page.keyboard.press(`${mod}+a`);
    expect(await h.runs()).toEqual(['bold', 'italic', 'undo', 'redo', 'redo', 'selectAll']);
    // Find opens the navigation pane at its search field.
    await focusSurface(page);
    await page.keyboard.press(`${mod}+f`);
    await expect(page.locator('.de-pane [data-search]')).toBeFocused();
    // The painter, with its key and with the alternative of the table.
    await h.setSelection({ empty: false, marks: ['bold'] });
    // The command is enabled once the shell has seen the selection; a key pressed before that finds
    // it disabled and does nothing.
    await expect(page.locator('[data-command-id="format.painter"]')).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await focusSurface(page);
    await page.keyboard.press(`${mod}+Shift+C`);
    await expect(page.locator('[data-command-id="format.painter"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.keyboard.press(`${mod}+Alt+Shift+C`);
    await expect(page.locator('[data-command-id="format.painter"]')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    // Landmarks with Ctrl+F6 and the alternative Alt+F6, back with Shift.
    await focusSurface(page);
    await page.keyboard.press('Control+F6');
    expect((await focused(page)).inside).toBe('pane');
    await page.keyboard.press('Alt+F6');
    expect((await focused(page)).inside).toBe('status');
    await page.keyboard.press('Shift+Alt+F6');
    expect((await focused(page)).inside).toBe('pane');
    await page.keyboard.press('Shift+Control+F6');
    expect((await focused(page)).className).toContain('de-editing-surface');
    // The context menu.
    await page.keyboard.press('Shift+F10');
    await expect(page.getByRole('menu', { name: 'Commands for the selection' })).toBeVisible();
    await page.keyboard.press('Escape');
    // The table's other key of the context menu row: the Menu key.
    await focusSurface(page);
    await page.keyboard.press('ContextMenu');
    await expect(page.getByRole('menu', { name: 'Commands for the selection' })).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('does nothing while focus is in the host page', async ({ page }) => {
    const h = await open(page);
    await page.locator('#after').focus();
    await page.keyboard.press(`${mod}+b`);
    await page.keyboard.press('Control+F6');
    expect(await h.runs()).toEqual([]);
    // Firefox takes Ctrl+F6 for its own focus cycle and moves focus out of the page, so `#after`
    // may lose focus there. What the editor must not do is take focus, so its shadow root has none.
    expect(
      await page.evaluate(
        () => document.getElementById('host')!.shadowRoot!.activeElement === null,
      ),
    ).toBe(true);
  });

  test('refuses a command whose keys collide, and replaces nothing', async ({ page }) => {
    const h = await open(page);
    expect(await h.tryRegister({ id: 'ext.bold', keys: ['Mod-b'] })).toMatch(
      /"ext\.bold": its key "Mod-b" is already bound to "format\.bold"; neither binding was changed/,
    );
    expect(await h.tryRegister({ id: 'ext.landmark', keys: ['Ctrl-F6'] })).toMatch(
      /kept by the shell/,
    );
    await focusSurface(page);
    await page.keyboard.press(`${mod}+b`);
    expect(await h.runs()).toEqual(['bold']);
  });

  test('explains a shortcut whose command may not run', async ({ page }) => {
    const h = await open(page, { access: VIEW_ONLY });
    await focusSurface(page);
    await page.keyboard.press(`${mod}+b`);
    expect(await h.runs()).toEqual([]);
    await expect(page.locator('.de-shell > [role="status"]')).toHaveText(
      'You can view this part of the document but not change it.',
    );
  });

  test('the reference is generated from the registry and the table', async ({ page }) => {
    const h = await open(page, { extended: true });
    await h.register('ext.stamp', 'command.format.bold', false, { keys: ['Alt-Shift-s'] });
    await h.exec('view.shortcuts');
    const table = page.locator('.de-pane[data-pane="shortcuts"] table');
    await expect(table).toBeVisible();
    for (const id of [
      'edit.undo',
      'edit.redo',
      'format.bold',
      'format.painter',
      'view.find',
      'ext.stamp',
      'shell.nextLandmark',
      'shell.contextMenu',
    ])
      await expect(table.locator(`tr[data-shortcut="${id}"]`)).toHaveCount(1);
    await expect(table.locator('tr[data-shortcut="shell.nextLandmark"] kbd')).toHaveText([
      'Ctrl+F6',
      'Alt+F6',
    ]);
    await expect(table.locator('tr[data-shortcut="ext.stamp"] kbd')).toHaveText(['Alt+Shift+S']);
  });
});
