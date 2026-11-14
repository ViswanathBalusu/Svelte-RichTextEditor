/**
 * Browser tests of the shell's WCAG 2.2 AA behaviour (UX-068): the dialog focus rules (criterion 7),
 * the labels in the same root as their controls (criterion 6), the target size of the pointer
 * targets (criterion 2) and axe on the toolbar and the dialogs (criterion 1). Run from the
 * repository root with `pnpm exec playwright test -c packages/ui/playwright.config.ts shell-wcag`.
 */
import type { Page } from '@playwright/test';
import { axe, expect, focusSurface, open, test } from './helpers.ts';

/** The shell's dialog that is open, as the dialog element names it, or null. */
async function openDialog(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const root = document.getElementById('host')!.shadowRoot!;
    const dialog = root.querySelector('dialog[open]');
    return dialog ? (dialog.getAttribute('data-dialog') ?? '') : null;
  });
}

/** Whether focus is inside the open dialog of the shell, and which element has it. */
async function focusInDialog(page: Page): Promise<{
  inside: string | null;
  className: string;
}> {
  return page.evaluate(() => {
    const root = document.getElementById('host')!.shadowRoot!;
    const active = root.activeElement as HTMLElement | null;
    return {
      inside: active?.closest('dialog')?.getAttribute('data-dialog') ?? null,
      className: active?.className ?? '',
    };
  });
}

test.describe('dialogs (UX-068 criterion 7)', () => {
  test('the export dialog moves focus in, Escape closes it and focus returns to the editing surface', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, features: ['exports'] });
    await focusSurface(page);
    await h.exec('document.export');
    const dialog = page.locator('dialog[part="dialog"][data-dialog]');
    await expect(dialog).toBeVisible();
    expect(await dialog.getAttribute('part')).toBe('dialog');
    expect(await openDialog(page)).not.toBeNull();
    // Focus is inside the dialog once it has opened.
    await expect.poll(async () => (await focusInDialog(page)).inside).not.toBeNull();

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(await openDialog(page)).toBeNull();
    // Back on the editing surface, the element that had focus before the dialog opened.
    await expect
      .poll(async () => (await focusInDialog(page)).className)
      .toContain('de-editing-surface');
  });

  test('the close button also closes the dialog and returns focus', async ({ page }) => {
    const h = await open(page, { extended: true, features: ['exports'] });
    await focusSurface(page);
    await h.exec('document.export');
    const dialog = page.locator('dialog[part="dialog"][data-dialog]');
    await expect(dialog).toBeVisible();
    await dialog.locator('.de-dialog-close').click();
    await expect(dialog).toHaveCount(0);
    await expect
      .poll(async () => (await focusInDialog(page)).className)
      .toContain('de-editing-surface');
  });
});

test.describe('labels (UX-068 criterion 6)', () => {
  test('every label and description reference resolves in the root of its control', async ({
    page,
  }) => {
    const h = await open(page, {
      extended: true,
      features: ['exports', 'presence'],
      toolbar: 'full',
      header: 'default',
      presence: [{ session: 's1', user: 'u1', status: 'active' }],
    });
    await h.exec('document.export');
    await expect(page.locator('dialog[part="dialog"][data-dialog]')).toBeVisible();
    const result = await page.evaluate(() => {
      const root = document.getElementById('host')!.shadowRoot!;
      const out: string[] = [];
      let references = 0;
      const check = (el: Element, attribute: string) => {
        const scope = el.getRootNode() as Document | ShadowRoot;
        for (const id of (el.getAttribute(attribute) ?? '').trim().split(/\s+/)) {
          if (!id) continue;
          references += 1;
          if (!scope.getElementById(id)) {
            out.push(`${attribute}="${id}" on ${el.tagName.toLowerCase()}.${el.className}`);
          }
        }
      };
      for (const el of root.querySelectorAll('[aria-labelledby]')) check(el, 'aria-labelledby');
      for (const el of root.querySelectorAll('[aria-describedby]')) check(el, 'aria-describedby');
      for (const label of root.querySelectorAll('label[for]')) {
        const scope = label.getRootNode() as Document | ShadowRoot;
        const id = label.getAttribute('for') ?? '';
        references += 1;
        if (!scope.getElementById(id)) out.push(`label for="${id}"`);
      }
      return { references, problems: out };
    });
    // The page has labelled controls to check (the dialog title, the presence list and the toolbar).
    expect(result.references).toBeGreaterThan(0);
    expect(result.problems).toEqual([]);
  });
});

test.describe('axe on the toolbar and the dialogs (UX-068 criterion 1)', () => {
  test('finds no violation with the full toolbar', async ({ page }) => {
    await open(page, { extended: true, toolbar: 'full' });
    expect(await axe(page)).toEqual([]);
  });

  test('finds no violation with the export dialog open', async ({ page }) => {
    const h = await open(page, { extended: true, features: ['exports'] });
    await focusSurface(page);
    await h.exec('document.export');
    await expect(page.locator('dialog[part="dialog"][data-dialog]')).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });
});

test.describe('pointer targets (UX-068 criterion 2)', () => {
  test('every visible control of the shell is at least 24 by 24 CSS pixels', async ({ page }) => {
    await open(page, { extended: true, toolbar: 'full', features: ['presence'], presence: [] });
    const result = await page.evaluate(() => {
      const root = document.getElementById('host')!.shadowRoot!;
      const out: string[] = [];
      let measured = 0;
      const controls = root.querySelectorAll<HTMLElement>(
        'button, [role="button"], [role="tab"], [role="menuitem"], [role="radio"], [role="checkbox"], select, input:not([type="hidden"])',
      );
      for (const el of controls) {
        if (el.closest('.de-page, [data-content], [hidden]')) continue;
        if (el.getClientRects().length === 0) continue;
        if ((el as HTMLButtonElement).disabled) continue;
        measured += 1;
        const box = el.getBoundingClientRect();
        if (box.width < 24 || box.height < 24) {
          out.push(
            `${el.tagName.toLowerCase()}.${el.className} ${Math.round(box.width)}x${Math.round(box.height)} "${(el.textContent ?? '').trim().slice(0, 30)}"`,
          );
        }
      }
      return { measured, small: out };
    });
    // The query found controls to measure; an empty query would pass the size check vacuously.
    expect(result.measured).toBeGreaterThan(0);
    expect(result.small).toEqual([]);
  });
});
