/**
 * The header: title slot, save and connection state, presence and the header's commands (UX-014,
 * UX-016, UX-026), with people from the host's directory (UX-025).
 */
import { expect, open, test } from './helpers.ts';

const ACTIVE = (session: string, user: string, name?: string) => ({
  session,
  user,
  status: 'active' as const,
  ...(name ? { name } : {}),
});
const IDLE = (session: string, user: string, name?: string) => ({
  ...ACTIVE(session, user, name),
  status: 'idle' as const,
});

test.describe('the header frame (UX-014)', () => {
  test('holds the title slot, the save state and presence, and exposes the header part', async ({
    page,
  }) => {
    await open(page, {
      slotTitle: 'Supply agreement',
      features: ['presence'],
      presence: [ACTIVE('s1', 'u1')],
    });
    const header = page.getByRole('region', { name: 'Document header' });
    await expect(header).toBeVisible();
    // The host's light-DOM element is assigned to the title slot and shown.
    await expect(page.locator('#host > [slot="title"]')).toBeVisible();
    const assigned = await page.evaluate(() => {
      const slot = document
        .getElementById('host')!
        .shadowRoot!.querySelector('slot[name="title"]') as HTMLSlotElement;
      return slot.assignedElements().map((e) => e.textContent);
    });
    expect(assigned).toEqual(['Supply agreement']);
    await expect(header.getByRole('group', { name: 'Save state' })).toBeVisible();
    await expect(header.getByRole('list', { name: 'People in this document' })).toBeVisible();
    expect(await header.evaluate((el) => getComputedStyle(el).outlineColor)).toBe('rgb(4, 5, 6)');
  });

  test('shows the title property when the slot is empty, and fetches nothing', async ({ page }) => {
    const requests: string[] = [];
    page.on('request', (r) => requests.push(new URL(r.url()).pathname));
    await open(page, { title: 'Board minutes' });
    await expect(page.locator('.de-header-title')).toHaveText('Board minutes');
    await open(page);
    await expect(page.locator('.de-header-title')).toHaveText('Document');
    // Only the harness's own files: no title, document or profile request.
    for (const path of requests)
      expect(path).toMatch(/^\/(|index\.html|assets\/.*|avatar\.png|favicon\.ico)$/);
  });

  test('shows a button only for an announced feature, with its count in words', async ({
    page,
  }) => {
    const h = await open(page, { headerPanes: true, counts: { comments: 3, catchUp: 1 } });
    const actions = page.locator('.de-header-actions');
    await expect(actions).toHaveCount(0);
    await h.setFeatures(['comments', 'history']);
    const comments = page.getByRole('button', { name: 'Comments, 3 open threads' });
    const catchUp = page.getByRole('button', { name: 'Catch up, 1 change since your last visit' });
    await expect(comments).toBeVisible();
    await expect(catchUp).toBeVisible();
    await h.setCounts({ comments: 1 });
    await expect(page.getByRole('button', { name: 'Comments, 1 open thread' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Catch up', exact: true })).toBeVisible();
    // Keyboard operable: it opens its pane, which loads on demand.
    await page.getByRole('button', { name: 'Comments, 1 open thread' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-stub-pane]')).toBeVisible();
    await h.setFeatures([]);
    await expect(actions).toHaveCount(0);
  });

  test('can be hidden by the host; the editor stays usable through commands', async ({ page }) => {
    const h = await open(page, { header: 'none', share: true });
    await expect(page.locator('.de-header')).toHaveCount(0);
    // The save state moves to the status bar, so it is never out of sight.
    await expect(page.locator('.de-status .de-save')).toContainText('Saved');
    expect(await h.exec('view.outline')).toEqual({ ran: true, reason: null });
    await expect(page.locator('.de-outline')).toBeVisible();
    expect(await h.exec('document.share')).toEqual({ ran: true, reason: null });
    expect(await h.shareRequests()).toHaveLength(1);
    await h.setSettings({ header: 'default' });
    await expect(page.locator('.de-header')).toBeVisible();
    // The status bar keeps showing it (UX-018 criterion 4); the header shows it too.
    await expect(page.locator('.de-status .de-save')).toHaveCount(1);
    await expect(page.locator('.de-header .de-save')).toHaveCount(1);
  });
});

test.describe('save state and connection state (UX-016)', () => {
  test('shows the four save states and three connection states in words', async ({ page }) => {
    const h = await open(page);
    const save = page.locator('.de-header').getByRole('group', { name: 'Save state' });
    const cases = [
      [{ connection: 'online', sync: 'saved' }, 'Saved', 'Online'],
      [{ connection: 'online', sync: 'saving' }, 'Saving', 'Online'],
      [{ connection: 'reconnecting', sync: 'unsaved' }, 'Not yet saved', 'Reconnecting'],
      [{ connection: 'offline', sync: 'unsaved' }, 'Not yet saved', 'Offline'],
      [{ connection: 'online', sync: 'readonly' }, 'Read-only', 'Online'],
    ] as const;
    for (const [status, sync, connection] of cases) {
      await h.setStatus(status);
      await expect(save.locator('[data-status="sync"]')).toHaveText(sync);
      await expect(save.locator('[data-status="connection"]')).toHaveText(connection);
    }
  });

  test('never tells the states apart by colour alone', async ({ page }) => {
    const h = await open(page);
    const look = async () =>
      page.locator('.de-header .de-save').evaluate((el) => {
        const mark = el.querySelector('.de-save-mark') as HTMLElement;
        const s = getComputedStyle(mark);
        return {
          text: el.textContent?.trim(),
          shape: `${s.borderStyle}|${s.borderRadius}|${s.backgroundColor}`,
        };
      });
    const states = [];
    for (const sync of ['saved', 'saving', 'unsaved', 'readonly'] as const) {
      await h.setStatus({ connection: 'online', sync });
      await h.frames(2);
      states.push(await look());
    }
    // Each state differs in its words and in the shape of its mark.
    expect(new Set(states.map((s) => s.text)).size).toBe(4);
    expect(new Set(states.map((s) => s.shape)).size).toBe(4);
  });

  test('shows nothing it cannot back: no status view, no save state', async ({ page }) => {
    await open(page, { minimal: true });
    await expect(page.locator('.de-save')).toHaveCount(0);
    await expect(page.getByRole('toolbar', { name: 'Editing' })).toBeVisible();
  });
});

test.describe('presence in the header (UX-026) and the host directory (UX-025)', () => {
  test('shows each person by avatar and name, live, with names from the host', async ({ page }) => {
    const h = await open(page, { features: ['presence'], presence: [ACTIVE('s1', 'u1')] });
    const people = page.getByRole('list', { name: 'People in this document' });
    await expect(people.locator('.de-person > .de-visually-hidden')).toHaveText(['Ada Lovelace']);
    // The host's avatar is used as an image address.
    await expect(people.locator('img')).toHaveAttribute(
      'src',
      /^http:\/\/127\.0\.0\.1:\d+\/avatar\.png$/,
    );
    await h.setPresence([ACTIVE('s1', 'u1'), ACTIVE('s2', 'u2')]);
    await expect(people.locator('.de-person > .de-visually-hidden')).toHaveText([
      'Ada Lovelace',
      'Grace Hopper',
    ]);
    await h.setPresence([ACTIVE('s2', 'u2')]);
    await expect(people.locator('.de-person > .de-visually-hidden')).toHaveText(['Grace Hopper']);
    // One call per batch of unique identifiers, answers cached.
    const calls = await h.resolveCalls();
    expect(calls).toEqual([['u1'], ['u2']]);
  });

  test('tells active and idle apart without colour', async ({ page }) => {
    await open(page, {
      features: ['presence'],
      presence: [ACTIVE('s1', 'u1'), IDLE('s2', 'u2')],
    });
    const items = page
      .getByRole('list', { name: 'People in this document' })
      .locator('.de-person > .de-visually-hidden');
    await expect(items).toHaveText(['Ada Lovelace', 'Grace Hopper, idle']);
    const borders = await page
      .locator('.de-avatars .de-avatar')
      .evaluateAll((els) => els.map((el) => getComputedStyle(el).borderTopStyle));
    expect(borders).toEqual(['solid', 'dashed']);
  });

  test('shows an overflow count and the full list by keyboard when not everyone fits', async ({
    page,
  }) => {
    const users = ['u1', 'u2', 'u5', 'u6', 'u7', 'u8', 'u9', 'u10', 'u11', 'u12'];
    await open(page, {
      width: 480,
      features: ['presence'],
      presence: users.map((u, i) => ACTIVE(`s${i}`, u)),
    });
    const more = page.locator('.de-presence-more');
    await expect(more).toBeVisible();
    const shown = await page.locator('.de-avatars > li').count();
    expect(shown).toBeLessThan(users.length);
    await expect(more).toHaveText(`+${users.length - shown}`);
    await expect(more).toHaveAccessibleName(`${users.length - shown} more people in this document`);
    await more.focus();
    await page.keyboard.press('Enter');
    const all = page.getByRole('list', { name: 'Everyone in this document' });
    await expect(all).toBeVisible();
    await expect(all.getByRole('listitem')).toHaveCount(users.length);
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(all).toBeHidden();
  });

  test('gives every entry a text name, with a neutral label when nobody knows it', async ({
    page,
  }) => {
    await open(page, {
      people: 'none',
      features: ['presence'],
      presence: [ACTIVE('s1', 'u1', 'Name from the service'), ACTIVE('s2', 'u404')],
    });
    const items = page
      .getByRole('list', { name: 'People in this document' })
      .locator('.de-person > .de-visually-hidden');
    await expect(items).toHaveText(['Name from the service', 'Collaborator']);
  });

  test('shows no presence region when the backend does not announce presence', async ({ page }) => {
    const h = await open(page, { features: [], presence: [ACTIVE('s1', 'u1')] });
    await expect(page.locator('.de-presence')).toHaveCount(0);
    await expect(page.getByRole('list', { name: 'People in this document' })).toHaveCount(0);
    expect(await h.resolveCalls()).toEqual([]);
  });

  test('renders host values as text and as image addresses, never as markup', async ({ page }) => {
    await open(page, {
      features: ['presence'],
      presence: [ACTIVE('s1', 'u3'), ACTIVE('s2', 'u4')],
    });
    const items = page
      .getByRole('list', { name: 'People in this document' })
      .locator('.de-person > .de-visually-hidden');
    await expect(items).toHaveText(['<img src=x onerror="window.__pwned=1">', 'Katherine Johnson']);
    const result = await page.evaluate(() => {
      const root = document.getElementById('host')!.shadowRoot!;
      return {
        pwned: (window as unknown as { __pwned?: number }).__pwned ?? 0,
        images: [...root.querySelectorAll('.de-presence img')].map((i) => i.getAttribute('src')),
      };
    });
    // No markup was parsed, and the javascript: address was not used as an image.
    expect(result).toEqual({ pwned: 0, images: [] });
  });

  test('keeps editing and the fallback when the directory fails, and retries', async ({ page }) => {
    const h = await open(page, {
      people: 'failing',
      features: ['presence'],
      presence: [ACTIVE('s1', 'u1', 'Service name')],
    });
    const items = page
      .getByRole('list', { name: 'People in this document' })
      .locator('.de-person > .de-visually-hidden');
    await expect(items).toHaveText(['Service name']);
    await page.getByRole('button', { name: 'Bold' }).click();
    expect(await h.runs()).toEqual(['bold']);
    await expect.poll(async () => (await h.resolveCalls()).length).toBeGreaterThan(1);
  });

  test('lists only the sessions the core says this user may see (ADR 0019)', async ({ page }) => {
    const h = await open(page, {
      features: ['presence'],
      presence: [ACTIVE('s1', 'u1'), ACTIVE('s2', 'u2')],
    });
    // The core withdraws a peer whose presence is inside content hidden from this user.
    await h.setPresence([ACTIVE('s1', 'u1')]);
    const items = page
      .getByRole('list', { name: 'People in this document' })
      .locator('.de-person > .de-visually-hidden');
    await expect(items).toHaveText(['Ada Lovelace']);
    await expect(page.locator('[data-user="u2"]')).toHaveCount(0);
  });
});
