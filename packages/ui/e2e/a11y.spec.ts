/**
 * axe on the shell in the states the phase 1a stories create (WCAG 2.2 level AA rule sets; README
 * definition of done: "axe reports no new violations"). UX-068 (phase 1b) owns the full audit and
 * the manual screen-reader passes; this keeps the shell clean from the start.
 */
import { axe, expect, open, test } from './helpers.ts';

const PEOPLE = ['u1', 'u2', 'u5', 'u6', 'u7', 'u8', 'u9'].map((user, i) => ({
  session: `s${i}`,
  user,
  status: i % 2 ? ('idle' as const) : ('active' as const),
}));

test.describe('axe finds no violation', () => {
  test('in the default shell', async ({ page }) => {
    await open(page, { slotTitle: 'Supply agreement' });
    expect(await axe(page)).toEqual([]);
  });

  test('with presence, header commands, counts and the full list open', async ({ page }) => {
    await open(page, {
      // Narrow enough that seven people never fit beside the title in any font: the header's commands
      // wrap onto a row of their own in wide fonts, which leaves the presence the whole row at 640.
      width: 420,
      features: ['presence', 'comments', 'history'],
      headerPanes: true,
      share: true,
      counts: { comments: 4, catchUp: 2 },
      presence: PEOPLE,
    });
    await page.locator('.de-presence-more').click();
    await expect(page.getByRole('list', { name: 'Everyone in this document' })).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });

  test('with disabled commands and their reasons, for a view-only user', async ({ page }) => {
    await open(page, { access: { scope: 'body', caps: ['view'], limit: 'role' } });
    await page.getByRole('button', { name: 'Bold' }).focus();
    expect(await axe(page)).toEqual([]);
  });

  test('with the overflow menu open', async ({ page }) => {
    await open(page, { width: 420 });
    await page.locator('.de-more').click();
    await expect(page.getByRole('menu')).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });

  test('with a pane and a sub-editor panel open', async ({ page }) => {
    const h = await open(page);
    await h.exec('view.outline');
    await h.exec('page.header');
    await page.locator('.de-outline').waitFor();
    await page.locator('.de-panel').waitFor();
    expect(await axe(page)).toEqual([]);
  });

  test('in every save and connection state, with the header hidden', async ({ page }) => {
    const h = await open(page, { header: 'none' });
    for (const status of [
      { connection: 'reconnecting', sync: 'saving' },
      { connection: 'offline', sync: 'unsaved' },
      { connection: 'online', sync: 'readonly' },
    ] as const) {
      await h.setStatus(status);
      await h.frames(2);
      expect(await axe(page)).toEqual([]);
    }
  });

  test('in the pseudo-locales', async ({ page }) => {
    const h = await open(page, { features: ['presence'], presence: PEOPLE.slice(0, 2) });
    for (const locale of ['en-XA', 'ar-XB']) {
      await h.setLocale(locale);
      await h.frames(2);
      expect(await axe(page), locale).toEqual([]);
    }
  });
});
