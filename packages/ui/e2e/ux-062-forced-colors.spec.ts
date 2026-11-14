/**
 * The shell under forced colours, rendered in a browser (UX-062, criterion 4). Forced colours are
 * emulated with Playwright (`emulateMedia({ forcedColors: 'active' })`). The shell is exercised with
 * the full toolbar: every control that was visible before is still visible, every visible text has
 * a contrast of at least 4.5 to 1 against the background it sits on, and the focused control keeps
 * a visible outline. Labels of disabled controls are not measured (WCAG 2.2 1.4.3 exempts inactive
 * components). Run from the repository root with
 * `pnpm exec playwright test -c packages/ui/playwright.config.ts ux-062-forced-colors`.
 */
import type { Page } from '@playwright/test';
import { expect, focusSurface, open, test } from './helpers.ts';

/** The names of the visible controls of the shell, in document order. */
async function visibleControls(page: Page): Promise<{ names: string[]; zeroBox: string[] }> {
  return page.evaluate(() => {
    const root = document.getElementById('host')!.shadowRoot!;
    const names: string[] = [];
    const zeroBox: string[] = [];
    const controls = root.querySelectorAll<HTMLElement>(
      'button, [role="button"], [role="tab"], [role="menuitem"], select, input:not([type="hidden"])',
    );
    for (const el of controls) {
      if (el.closest('.de-page, [data-content], [hidden]')) continue;
      if (el.getClientRects().length === 0) continue;
      const name = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim();
      names.push(name || el.className);
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) zeroBox.push(name || el.className);
    }
    return { names, zeroBox };
  });
}

/**
 * Each visible text run of the shell, with its colour and the first opaque background above it,
 * and the WCAG contrast of the two. Runs in the page, so it reads the cascade as rendered.
 */
async function textContrasts(page: Page): Promise<Array<{ text: string; ratio: number }>> {
  return page.evaluate(() => {
    const root = document.getElementById('host')!.shadowRoot!;
    const parse = (value: string): [number, number, number, number] | null => {
      const m = value.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const parts = m[1]!
        .split(/[ ,/]+/)
        .filter(Boolean)
        .map(Number);
      return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
    };
    const luminance = ([r, g, b]: [number, number, number, number]): number => {
      const lin = (c: number) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    };
    const backgroundOf = (el: Element): [number, number, number, number] => {
      for (let node: Element | null = el; node; node = node.parentElement) {
        const bg = parse(getComputedStyle(node).backgroundColor);
        if (bg && bg[3] === 1) return bg;
      }
      return [255, 255, 255, 1];
    };
    const out: Array<{ text: string; ratio: number }> = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim() ?? '';
      const parent = node.parentElement;
      if (!text || !parent) continue;
      if (parent.closest('.de-page, [data-content], [hidden]')) continue;
      if (parent.getClientRects().length === 0) continue;
      // WCAG 2.2 1.4.3 exempts inactive components: a disabled control's label is not measured.
      if (parent.closest('[disabled], [aria-disabled="true"]')) continue;
      const fg = parse(getComputedStyle(parent).color);
      if (!fg) continue;
      const bg = backgroundOf(parent);
      const l1 = luminance(fg);
      const l2 = luminance(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      out.push({ text: text.slice(0, 40), ratio: Math.round(ratio * 100) / 100 });
    }
    return out;
  });
}

test.describe('the shell under forced colours (UX-062, criterion 4)', () => {
  test('the emulation is active in this browser', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await open(page, { extended: true, toolbar: 'full' });
    expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);
  });

  test('no control disappears or collapses under forced colours', async ({ page }) => {
    await open(page, { extended: true, toolbar: 'full' });
    const before = await visibleControls(page);
    expect(before.names.length).toBeGreaterThan(0);

    await page.emulateMedia({ forcedColors: 'active' });
    await expect
      .poll(() => page.evaluate(() => matchMedia('(forced-colors: active)').matches))
      .toBe(true);
    const after = await visibleControls(page);
    expect(after.zeroBox).toEqual([]);
    expect(after.names).toEqual(before.names);
  });

  test('every visible text keeps a contrast of at least 4.5 to 1 under forced colours', async ({
    page,
  }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await open(page, { extended: true, toolbar: 'full' });
    const runs = await textContrasts(page);
    // The walk found text to measure; an empty walk would pass the check vacuously.
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.filter((r) => r.ratio < 4.5)).toEqual([]);
  });

  test('the focused control keeps a visible outline under forced colours', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await open(page, { extended: true, toolbar: 'full' });
    await focusSurface(page);
    await page.keyboard.press('Tab');
    const outline = await page.evaluate(() => {
      const root = document.getElementById('host')!.shadowRoot!;
      const active = root.activeElement as HTMLElement | null;
      if (!active) return null;
      const style = getComputedStyle(active);
      return {
        focusVisible: active.matches(':focus-visible'),
        outlineStyle: style.outlineStyle,
        outlineWidth: parseFloat(style.outlineWidth),
      };
    });
    expect(outline).not.toBeNull();
    expect(outline!.focusVisible).toBe(true);
    expect(outline!.outlineStyle).not.toBe('none');
    expect(outline!.outlineWidth).toBeGreaterThanOrEqual(1);
  });
});
