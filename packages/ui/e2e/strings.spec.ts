/**
 * Externalised strings and direction-neutral layout in the browser (UX-064; UX-003 criterion 6):
 * the pseudo-locale transforms every visible string and nothing is clipped or overlapping; tables
 * load on demand; the right-to-left pseudo-locale mirrors the shell but not the document.
 */
import type { Page } from '@playwright/test';
import { expect, open, test, visibleStrings } from './helpers.ts';

const BUSY = {
  features: ['presence', 'comments', 'history'],
  headerPanes: true,
  share: true,
  counts: { comments: 2, catchUp: 5 },
  presence: [
    { session: 's1', user: 'u1', status: 'active' as const },
    { session: 's2', user: 'u2', status: 'idle' as const },
  ],
};

/** Boxes of the visible controls and texts in one container, and whether any of them is clipped. */
async function layoutOf(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const root = document.getElementById('host')!.shadowRoot!;
    const container = root.querySelector(sel);
    if (!container) return null;
    const outer = container.getBoundingClientRect();
    const selectors =
      'button, [data-status], .de-save-sync, .de-save-connection, li, .de-outline-empty';
    const items = [...container.querySelectorAll<HTMLElement>(selectors)]
      .filter((el) => el.getClientRects().length > 0 && !el.closest('[hidden]'))
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          text: el.textContent?.trim() ?? '',
          box: { x: r.x, y: r.y, w: r.width, h: r.height },
          clipped: el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1,
          outside: r.x < outer.x - 0.5 || r.right > outer.right + 0.5,
        };
      });
    return { items, outer: { x: outer.x, w: outer.width } };
  }, selector);
}

function overlaps(items: Array<{ box: { x: number; y: number; w: number; h: number } }>): number {
  let count = 0;
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!.box;
      const b = items[j]!.box;
      // Nested boxes (a mark inside its group) are not overlaps.
      const inside =
        (a.x >= b.x && a.x + a.w <= b.x + b.w && a.y >= b.y && a.y + a.h <= b.y + b.h) ||
        (b.x >= a.x && b.x + b.w <= a.x + a.w && b.y >= a.y && b.y + b.h <= a.y + a.h);
      if (inside) continue;
      const separate =
        a.x + a.w <= b.x + 0.5 ||
        b.x + b.w <= a.x + 0.5 ||
        a.y + a.h <= b.y + 0.5 ||
        b.y + b.h <= a.y + 0.5;
      if (!separate) count++;
    }
  return count;
}

test.describe('the pseudo-locale (UX-064, criterion 4)', () => {
  test('transforms every visible string of the shell', async ({ page }) => {
    const h = await open(page, { ...BUSY, locale: 'en-XA' });
    await expect(page.locator('.de-toolbar')).toHaveAttribute('lang', 'en-XA');
    // Open a pane and a sub-editor panel too, so their strings are checked.
    await h.exec('view.outline');
    await h.exec('insert.footnote');
    await page.locator('.de-outline').waitFor();
    await page.locator('.de-panel').waitFor();
    const strings = await visibleStrings(page);
    expect(strings.length).toBeGreaterThan(20);
    // Numbers (counts) carry no letters and are formatted, not translated.
    const untransformed = strings.filter(
      (s) => /\p{L}/u.test(s.text) && !/^\[.*\]$/su.test(s.text),
    );
    expect(untransformed).toEqual([]);
  });

  test('clips nothing and overlaps nothing in the toolbar, header, panes and status bar', async ({
    page,
  }) => {
    const h = await open(page, { ...BUSY, locale: 'en-XA', width: 1000 });
    await h.exec('view.outline');
    await page.locator('.de-outline').waitFor();
    await h.frames(3);
    for (const selector of ['.de-toolbar', '.de-header', '.de-status', '.de-pane']) {
      const layout = await layoutOf(page, selector);
      expect(layout, selector).not.toBeNull();
      const { items } = layout!;
      expect(items.length, selector).toBeGreaterThan(0);
      expect(
        items.filter((i) => i.clipped).map((i) => i.text),
        `${selector}: clipped`,
      ).toEqual([]);
      expect(
        items.filter((i) => i.outside).map((i) => i.text),
        `${selector}: outside`,
      ).toEqual([]);
      expect(overlaps(items), `${selector}: overlapping`).toBe(0);
    }
    // The toolbar is still one row, with what does not fit behind "More".
    const tops = await page
      .locator('.de-toolbar > button:not([hidden])')
      .evaluateAll(
        (els) => new Set(els.map((el) => Math.round(el.getBoundingClientRect().top))).size,
      );
    expect(tops).toBe(1);
  });
});

test.describe('string tables load on demand (UX-064, criterion 2)', () => {
  test('requests the pseudo-locale table only when it is chosen', async ({ page }) => {
    const chunks: string[] = [];
    page.on('request', (r) => {
      const path = new URL(r.url()).pathname;
      if (path.startsWith('/assets/')) chunks.push(path);
    });
    const h = await open(page);
    expect(chunks.filter((c) => c.includes('pseudo'))).toEqual([]);
    await h.setLocale('en-XA');
    await expect(page.getByRole('toolbar')).toHaveAttribute('lang', 'en-XA');
    expect(chunks.filter((c) => c.includes('pseudo'))).toHaveLength(1);
    await expect(page.locator('[data-command-id="format.bold"]')).toHaveText(/^\[Ɓóļð·+\]$/);
  });

  test('falls back to the default table for a locale without one', async ({ page }) => {
    const h = await open(page);
    await h.setSettings({ locale: 'fr-CA' });
    await h.frames(2);
    await expect(page.getByRole('toolbar')).toHaveAttribute('lang', 'en-GB');
    await expect(page.locator('[data-command-id="format.bold"]')).toHaveText('Bold');
  });

  test('labels come from the tables, and the core gets its surface names from them', async ({
    page,
  }) => {
    const h = await open(page);
    expect(await h.labels()).toEqual({
      body: 'Document',
      footnote: 'Footnote text',
      story: 'Header',
    });
    await h.setLocale('en-XA');
    await expect(page.locator('[data-command-id="format.bold"]')).toHaveText(/^\[/);
    expect((await h.labels())!.body).toMatch(/^\[Ðóçúɱéñţ·+\]$/);
  });
});

test.describe('right to left (UX-064, criterion 7)', () => {
  test('mirrors the shell and keeps the document left to right', async ({ page }) => {
    const h = await open(page, { ...BUSY, width: 1000 });
    const ltr = await layoutOf(page, '.de-toolbar');
    await h.setLocale('ar-XB');
    await expect(page.locator('.de-shell')).toHaveAttribute('dir', 'rtl');
    await h.frames(3);
    const rtl = await layoutOf(page, '.de-toolbar');
    const first = (l: NonNullable<typeof ltr>) => l.items[0]!.box;
    // The first control moves from the inline start on the left to the inline start on the right.
    expect(first(ltr!).x - ltr!.outer.x).toBeLessThan(40);
    expect(rtl!.outer.x + rtl!.outer.w - (first(rtl!).x + first(rtl!).w)).toBeLessThan(40);
    expect(overlaps(rtl!.items)).toBe(0);
    expect(rtl!.items.filter((i) => i.clipped || i.outside)).toEqual([]);
    // The document keeps its own direction.
    const page_ = await page.evaluate(() => {
      const root = document.getElementById('host')!.shadowRoot!;
      const surface = root.querySelector('.de-editing-surface')!;
      return {
        page: getComputedStyle(root.querySelector('.de-page')!).direction,
        surface: getComputedStyle(surface).direction,
      };
    });
    expect(page_).toEqual({ page: 'ltr', surface: 'ltr' });
    // Arrow keys follow the reading direction.
    await page.locator('[data-command-id="edit.undo"]').focus();
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('[data-command-id="edit.redo"]')).toBeFocused();
  });
});
