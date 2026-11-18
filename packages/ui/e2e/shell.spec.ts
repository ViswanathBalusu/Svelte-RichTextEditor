/**
 * The shell's frame in phase 1b: the status bar (UX-018), landmarks by keyboard (UX-023), the mode
 * switcher (UX-015), collaborators' carets (UX-027), sharing (UX-039), hidden content (UX-104) and
 * one interface update per frame (UX-072 criterion 4).
 */
import { expect, focusSurface, focused, open, test } from './helpers.ts';

test.describe('the status bar (UX-018)', () => {
  test('shows the word count, and a page count only from a typeset result', async ({ page }) => {
    const h = await open(page, { extended: true });
    const bar = page.locator('.de-status');
    await expect(bar.locator('[data-status="words"]')).toHaveText('6 words');
    await expect(bar.locator('[data-status="pages"]')).toHaveCount(0);
    await h.setStats({ words: 1, pages: { count: 12, seq: 40, stale: false } });
    await expect(bar.locator('[data-status="words"]')).toHaveText('1 word');
    await expect(bar.locator('[data-status="pages"]')).toHaveText('12 pages in the PDF');
    await h.setStats({ words: 1, pages: { count: 12, seq: 40, stale: true } });
    await expect(bar.locator('[data-status="pages"]')).toHaveText(
      '12 pages in the last PDF, made before the latest changes',
    );
    expect(await bar.getAttribute('part')).toBe('statusbar');
  });

  test('shows the language at the caret, and sets it through the guards', async ({ page }) => {
    const h = await open(page, { extended: true, language: 'en-GB' });
    const language = page.locator('.de-status [data-status="language"]');
    await expect(language).toHaveText('Language: British English, the document’s language');
    await h.setSelection({ lang: 'de-CH' });
    await expect(language).toHaveText('Language: Swiss High German');
    await language.click();
    const dialog = page.getByRole('dialog', { name: 'Language of the selected text' });
    await expect(dialog).toBeVisible();
    const field = dialog.getByRole('textbox', { name: 'Language tag' });
    await expect(field).toBeFocused();
    await field.fill('not a tag!');
    await expect(dialog.getByText('This is not a valid language tag.')).toBeVisible();
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await field.fill('fr');
    await expect(dialog.getByText('Language: French')).toBeVisible();
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await expect(dialog).toHaveCount(0);
    expect(await h.named()).toEqual([['setLanguage', { lang: 'fr' }]]);
    await expect(language).toHaveText('Language: French');
    await expect(language).toBeFocused();
    // Where the user may not change the text, the command says why.
    await h.setAccess({ scope: 'body', caps: ['view'], limit: 'role' });
    await expect(language).toHaveAttribute('aria-disabled', 'true');
  });

  test('shows the save and connection state and zooms by pointer and keyboard', async ({
    page,
  }) => {
    const h = await open(page, { extended: true });
    const bar = page.locator('.de-status');
    await h.setStatus({ connection: 'reconnecting', sync: 'unsaved' });
    await expect(bar.locator('[data-status="sync"]')).toHaveText('Not yet saved');
    await expect(bar.locator('[data-status="connection"]')).toHaveText('Reconnecting');
    const zoom = bar.getByRole('group', { name: 'Zoom' });
    await expect(zoom.locator('[data-status="zoom"]')).toHaveText('100%');
    const before = (await page.locator('.de-editing-surface').boundingBox())!;
    await zoom.getByRole('button', { name: 'Zoom in' }).click();
    await expect(zoom.locator('[data-status="zoom"]')).toHaveText('110%');
    await zoom.getByRole('button', { name: 'Zoom in' }).focus();
    await page.keyboard.press('Enter');
    await expect(zoom.locator('[data-status="zoom"]')).toHaveText('125%');
    const after = (await page.locator('.de-editing-surface').boundingBox())!;
    expect(after.height).toBeGreaterThan(before.height);
    // The document is not changed: no command of the core ran.
    expect(await h.runs()).toEqual([]);
    expect(await h.named()).toEqual([]);
    expect(await h.exec('view.zoomReset')).toEqual({ ran: true, reason: null });
    await expect(zoom.locator('[data-status="zoom"]')).toHaveText('100%');
    await expect(zoom.getByRole('button', { name: 'Reset zoom' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });
});

test.describe('landmarks by keyboard (UX-023)', () => {
  test('Ctrl+F6 goes header, toolbar, page, panes, status bar, and Shift+Ctrl+F6 back', async ({
    page,
  }) => {
    const h = await open(page, {
      features: ['presence'],
      presence: [{ session: 's1', user: 'u1', status: 'active' }],
      share: true,
    });
    await h.exec('view.outline');
    await focusSurface(page);
    const order: Array<string | null> = [];
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Control+F6');
      order.push((await focused(page)).inside);
    }
    expect(order).toEqual(['pane', 'status', 'header', 'toolbar', 'page']);
    await page.keyboard.press('Shift+Control+F6');
    expect((await focused(page)).inside).toBe('toolbar');
    await page.keyboard.press('Alt+F6');
    expect((await focused(page)).className).toContain('de-editing-surface');
  });

  test('skips what is absent and can always leave the component', async ({ page }) => {
    await open(page, { header: 'none', toolbar: 'none' });
    await focusSurface(page);
    await page.keyboard.press('Control+F6');
    expect((await focused(page)).inside).toBe('status');
    await page.keyboard.press('Control+F6');
    expect((await focused(page)).className).toContain('de-editing-surface');
    // Tab from the last control of the component reaches the host page.
    await page.locator('.de-status button').last().focus();
    for (let i = 0; i < 6; i++) {
      if (await page.locator('#after').evaluate((el) => el === document.activeElement)) break;
      await page.keyboard.press('Tab');
    }
    await expect(page.locator('#after')).toBeFocused();
  });

  test('names every landmark, and keeps labels in the same root', async ({ page }) => {
    const h = await open(page, { extended: true, styles: [] });
    await h.exec('view.styles');
    // The pane renders in a later frame; count the landmarks only once it is there.
    await expect(page.locator('[data-landmark="pane"]')).toHaveCount(1);
    const landmarks = await page.evaluate(() => {
      const root = document.getElementById('host')!.shadowRoot!;
      return [...root.querySelectorAll('[data-landmark]')].map((el) => ({
        role: el.getAttribute('role') ?? el.tagName.toLowerCase(),
        named: Boolean(
          el.getAttribute('aria-label') ||
          (el.getAttribute('aria-labelledby') &&
            root.getElementById(el.getAttribute('aria-labelledby')!)?.textContent?.trim()),
        ),
      }));
    });
    expect(landmarks.length).toBeGreaterThanOrEqual(5);
    for (const l of landmarks) expect(l.named, l.role).toBe(true);
    const dangling = await page.evaluate(() => {
      const root = document.getElementById('host')!.shadowRoot!;
      const out: string[] = [];
      for (const el of root.querySelectorAll(
        '[aria-labelledby], [aria-describedby], [aria-controls], label[for]',
      ))
        for (const attr of ['aria-labelledby', 'aria-describedby', 'aria-controls', 'for'])
          for (const id of (el.getAttribute(attr) ?? '').split(/\s+/).filter(Boolean))
            if (!root.getElementById(id)) out.push(`${attr}=${id}`);
      return out;
    });
    expect(dangling).toEqual([]);
  });
});

test.describe('the mode switcher (UX-015)', () => {
  test('offers the modes the build supports, within the user’s rights', async ({ page }) => {
    const h = await open(page, {
      extended: true,
      modes: ['edit', 'review', 'view', 'fill'],
      permissions: {
        rev: 1,
        docRole: 'commenter',
        caps: ['view', 'comment'],
        scopes: { body: ['view', 'comment'] },
      },
      access: { scope: 'body', caps: ['view', 'comment'], limit: 'role' },
      mode: 'view',
    });
    const button = page.locator('.de-mode-button');
    await expect(button).toHaveAccessibleName('Mode: Viewing');
    await button.click();
    const menu = page.getByRole('menu', { name: 'Modes' });
    await expect(menu.getByRole('menuitemradio')).toHaveText([
      'Editing',
      'Reviewing',
      'Viewing',
      'Filling in',
    ]);
    await expect(menu.getByRole('menuitemradio', { name: 'Viewing', exact: true })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    const edit = menu.getByRole('menuitemradio', { name: 'Editing' });
    await expect(edit).toHaveAttribute('aria-disabled', 'true');
    await expect(edit).toHaveAccessibleDescription(
      'You do not have permission to edit this document.',
    );
    await expect(
      menu.getByRole('menuitemradio', { name: 'Filling in' }),
    ).toHaveAccessibleDescription('You have no fields to fill in this document.');
    await edit.click({ force: true });
    expect(await h.callsOf('setMode')).toEqual([]);
  });

  test('shows edit unavailable while the document is locked or only suggestions are allowed', async ({
    page,
  }) => {
    const h = await open(page, {
      extended: true,
      modes: ['edit', 'review', 'view'],
      access: { scope: 'body', caps: ['view', 'comment'], limit: 'locked' },
    });
    await page.locator('.de-mode-button').click();
    await expect(page.getByRole('menuitemradio', { name: 'Editing' })).toHaveAccessibleDescription(
      'The document is locked.',
    );
    await page.keyboard.press('Escape');
    await h.setAccess({ scope: 'body', caps: ['view', 'comment', 'suggest'], limit: 'role' });
    await page.locator('.de-mode-button').click();
    await expect(page.getByRole('menuitemradio', { name: 'Editing' })).toHaveAccessibleDescription(
      'You may only suggest changes here, so the editor stays in reviewing.',
    );
    await expect(page.getByRole('menuitemradio', { name: 'Reviewing' })).not.toHaveAttribute(
      'aria-disabled',
    );
  });

  test('changes the mode, shows and announces it, and view mode stops content commands', async ({
    page,
  }) => {
    const h = await open(page, { extended: true });
    await page.locator('.de-mode-button').click();
    await page.getByRole('menuitemradio', { name: 'Viewing', exact: true }).click();
    expect(await h.callsOf('setMode')).toEqual([['view']]);
    await expect(page.locator('.de-mode-button')).toHaveAccessibleName('Mode: Viewing');
    await expect(page.locator('.de-shell > [role="status"]')).toHaveText('Mode: Viewing.');
    expect(await h.state('format.bold')).toMatchObject({ enabled: false, reason: 'mode' });
    await expect(page.locator('[data-command-id="format.bold"]')).toHaveAccessibleDescription(
      'The document is open for viewing. Switch to editing to change it.',
    );
    // A mode set by the host is shown and announced as well.
    await h.setMode('edit');
    await expect(page.locator('.de-mode-button')).toHaveAccessibleName('Mode: Editing');
    await expect(page.locator('.de-shell > [role="status"]')).toHaveText('Mode: Editing.');
  });
});

test.describe('collaborators’ carets (UX-027)', () => {
  const CARET = (session: string, user: string, x: number) => ({
    session,
    user,
    status: 'active' as const,
    caret: { x, y: 4, width: 0, height: 18 },
    selection: [{ x, y: 4, width: 60, height: 18 }],
  });

  test('draws a flag naming each person in text; the pointer and focus pass through', async ({
    page,
  }) => {
    const h = await open(page, {
      extended: true,
      carets: [CARET('s1', 'u1', 40), CARET('s2', 'u2', 140)],
    });
    const flags = page.locator('.de-peer-flag');
    await expect(flags).toHaveText(['Ada Lovelace', 'Grace Hopper']);
    await expect(page.locator('.de-carets')).toHaveAttribute('aria-hidden', 'true');
    const point = await flags.first().evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    const hit = await page.evaluate(({ x, y }) => {
      const root = document.getElementById('host')!.shadowRoot!;
      const el = root.elementFromPoint(x, y);
      return el?.closest('.de-carets') ? 'layer' : (el?.className ?? '');
    }, point);
    expect(hit).not.toBe('layer');
    expect(await page.locator('.de-carets [tabindex]').count()).toBe(0);
    // A peer whose position cannot be mapped is not drawn; one the view leaves out is gone.
    await h.setCarets([{ ...CARET('s1', 'u1', 40), caret: null, selection: [] }]);
    await expect(page.locator('.de-peer-caret')).toHaveCount(0);
    await expect(flags).toHaveCount(0);
  });

  test('keeps the person in text under forced colours', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'forced colours are emulated in Chromium only');
    await page.emulateMedia({ forcedColors: 'active' });
    await open(page, { extended: true, carets: [CARET('s1', 'u1', 40)] });
    const flag = page.locator('.de-peer-flag');
    await expect(flag).toHaveText('Ada Lovelace');
    const colours = await flag.evaluate((el) => {
      const s = getComputedStyle(el);
      return [s.color, s.backgroundColor];
    });
    expect(colours[0]).not.toBe(colours[1]);
  });
});

test.describe('the share button (UX-039)', () => {
  test('asks the host, shows no dialog of its own, and focus comes back to it', async ({
    page,
  }) => {
    const h = await open(page, { share: true });
    const share = page.getByRole('button', { name: 'Share' });
    await share.focus();
    await page.keyboard.press('Enter');
    expect(await h.shareRequests()).toHaveLength(1);
    await expect(page.locator('#share-dialog')).toBeVisible();
    await expect(page.locator('.de-shell dialog')).toHaveCount(0);
    await page.locator('#share-dialog button').click();
    await expect(share).toBeFocused();
    // Nothing else was asked of the core: no grants, no participants.
    expect(await h.calls()).not.toContain('runNamed');
  });
});

test.describe('hidden content (UX-104; ADR 0019)', () => {
  test('says in plain words that the reader has no access, and passes a request to the host', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, accessRequests: true });
    await h.moveTo(
      { scope: 'region:rH', caps: [], limit: 'hidden' },
      { scope: 'region', region: null },
    );
    const live = page.locator('.de-shell > [role="status"]');
    await expect(live).toHaveText('You do not have access to this part of the document.');
    const status = page.locator('.de-status [data-status="hidden"]');
    await expect(status).toContainText('You do not have access to this part of the document.');
    await expect(status).not.toContainText(/Ada|Grace|owner|editor/);
    await status.getByRole('button', { name: 'Ask for access' }).click();
    expect(await h.accessRequests()).toEqual(['region:rH']);
    await expect(status).toContainText('Your request for access was passed on.');
    // The editor sent nothing of its own: no command ran.
    expect(await h.runs()).toEqual([]);
    expect(await h.named()).toEqual([]);
  });

  test('shows no caret, flag or person of a collaborator inside hidden content', async ({
    page,
  }) => {
    const h = await open(page, {
      extended: true,
      features: ['presence'],
      presence: [{ session: 's1', user: 'u1', status: 'active' }],
      carets: [
        {
          session: 's1',
          user: 'u1',
          status: 'active',
          caret: { x: 10, y: 4, width: 0, height: 18 },
          selection: [],
        },
      ],
    });
    await expect(page.locator('.de-peer-flag')).toHaveText('Ada Lovelace');
    // The core's views leave out a peer whose selection is in hidden content.
    await h.setCarets([]);
    await h.setPresence([]);
    await expect(page.locator('.de-peer-flag')).toHaveCount(0);
    await expect(page.locator('[data-user="u1"]')).toHaveCount(0);
  });
});

test.describe('one interface update per frame (UX-072 criterion 4)', () => {
  test('a burst of changes in one frame is drawn in that frame', async ({ page }) => {
    await open(page, { notify: 'shared', features: ['presence'] });
    const frames = await page.evaluate(async () => {
      const h = (window as unknown as { harness: Record<string, (...a: unknown[]) => unknown> })
        .harness;
      const root = document.getElementById('host')!.shadowRoot!;
      const marks: number[] = [];
      let frame = 0;
      let counting = true;
      const tick = () => {
        frame++;
        if (counting) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      await new Promise((r) => requestAnimationFrame(r));
      const observer = new MutationObserver(() => marks.push(frame));
      observer.observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      h['setSelection']!({ marks: ['bold'] });
      h['setAccess']!({ scope: 'body', caps: ['view'], limit: 'role' });
      h['setStatus']!({ connection: 'reconnecting', sync: 'saving' });
      h['setPresence']!([{ session: 's1', user: 'u404', status: 'active' }]);
      for (let i = 0; i < 6; i++) await new Promise((r) => requestAnimationFrame(r));
      counting = false;
      observer.disconnect();
      return [...new Set(marks)];
    });
    // All the changes reached the page in one and the same frame.
    expect(frames).toHaveLength(1);
  });
});
