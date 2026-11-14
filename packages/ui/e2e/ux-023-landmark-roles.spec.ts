/**
 * UX-023 criterion 4 (lane U-UX-016-030): each landmark has a role and an accessible name, for the
 * compact and the full toolbar alike. The existing landmark test checks names only; this file checks
 * the role of every `[data-landmark]` element of the shell, as the browser computes it.
 */
import type { Page } from '@playwright/test';
import { expect, open, test } from './helpers.ts';

/** The role each landmark is allowed to have: an explicit `role`, or the element's implicit one. */
const ALLOWED: Record<string, string[]> = {
  header: ['region', 'banner'],
  toolbar: ['toolbar', 'region'],
  page: ['region'],
  pane: ['complementary', 'region'],
  status: ['region', 'contentinfo', 'status'],
};

async function landmarks(page: Page) {
  return page.evaluate(() => {
    const root = document.getElementById('host')!.shadowRoot!;
    return [...root.querySelectorAll('[data-landmark]')].map((el) => {
      const tag = el.tagName.toLowerCase();
      const explicit = el.getAttribute('role');
      const name =
        el.getAttribute('aria-label')?.trim() ||
        (el.getAttribute('aria-labelledby')
          ? (root.getElementById(el.getAttribute('aria-labelledby')!)?.textContent ?? '').trim()
          : '');
      return {
        kind: el.getAttribute('data-landmark')!,
        role: explicit ?? (tag === 'aside' ? 'complementary' : tag === 'header' ? 'banner' : tag),
        name,
        tag,
      };
    });
  });
}

test.describe('landmark roles and names (UX-023 criterion 4)', () => {
  test('the compact toolbar, the page, the status bar and the header each have a role and a name', async ({
    page,
  }) => {
    const h = await open(page, { extended: true });
    await h.exec('view.outline');
    await expect(page.locator('.de-pane[data-pane="outline"]')).toBeVisible();
    const found = await landmarks(page);
    const kinds = found.map((l) => l.kind);
    expect(kinds).toEqual(expect.arrayContaining(['header', 'toolbar', 'page', 'status', 'pane']));
    for (const l of found) {
      expect(ALLOWED[l.kind], `${l.kind} (${l.tag})`).toContain(l.role);
      expect(l.name, `${l.kind} name`).not.toBe('');
    }
  });

  test('the full toolbar is a named region, not an anonymous block', async ({ page }) => {
    await open(page, { extended: true, toolbar: 'full' });
    const found = await landmarks(page);
    const full = found.find((l) => l.kind === 'toolbar');
    expect(full, 'the full toolbar is a landmark').toBeDefined();
    expect(full!.role).toBe('region');
    expect(full!.name).toBe('Editing');
    expect(page.locator('.de-toolbar-full')).toHaveAttribute('role', 'region');
    // The role is exposed to assistive technology, not only in the markup.
    await expect(page.getByRole('region', { name: 'Editing' }).first()).toBeAttached();
  });

  test('every label reference resolves inside the shell root, not in the host page', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, toolbar: 'full' });
    await h.exec('view.outline');
    await expect(page.locator('.de-pane[data-pane="outline"]')).toBeVisible();
    const refs = await page.evaluate(() => {
      const root = document.getElementById('host')!.shadowRoot!;
      return [...root.querySelectorAll('[aria-labelledby]')].map((el) => {
        const ids = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
        return { ids, resolved: ids.map((id) => Boolean(root.getElementById(id))) };
      });
    });
    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs) expect(r.resolved, r.ids.join(' ')).not.toContain(false);
  });
});
