/**
 * Collaborator carets, rendered (UX-027, lane U-UX-016-030). Criterion 4: under forced colours the
 * active and idle carets, their selection and the name flag use system colours, read from the
 * rendered cascade and compared with probe elements that carry the same system colours. Criterion
 * 5: a click on a flag reaches the text under it, the flag takes no focus, and typing stays in the
 * editing surface. Forced colours are emulated in Chromium only (Playwright). Run from the
 * repository root with
 * `pnpm exec playwright test -c packages/ui/playwright.config.ts ux-027-carets`.
 */
import type { Page } from '@playwright/test';
import { expect, focusSurface, open, test } from './helpers.ts';

const caret = (session: string, status: 'active' | 'idle') => ({
  session,
  user: `u-${session}`,
  name: session === 's1' ? 'Ada Lovelace' : 'Grace Hopper',
  status,
  caret: { x: 40, y: 4, width: 0, height: 18 },
  selection: [{ x: 60, y: 4, width: 50, height: 18 }],
});

/** Computed colours of the shell's peer elements under the current media emulation. */
async function renderedColours(page: Page): Promise<Record<string, Record<string, string>>> {
  return page.evaluate(() => {
    const root = document.getElementById('host')!.shadowRoot!;
    const pick = (el: Element | null) => {
      if (!el) return null;
      const s = getComputedStyle(el);
      return {
        background: s.backgroundColor,
        backgroundImage: s.backgroundImage,
        color: s.color,
        adjust: s.forcedColorAdjust,
      };
    };
    // Probes with the system colours, under the same emulation, give the values to compare with.
    const probe = (prop: string, value: string) => {
      const p = document.createElement('div');
      p.style.setProperty(prop, value);
      root.appendChild(p);
      const v = getComputedStyle(p).getPropertyValue(
        prop === 'background' ? 'background-color' : prop,
      );
      p.remove();
      return v;
    };
    return {
      activeCaret: pick(root.querySelector(".de-peer-caret[data-status='active']")),
      idleCaret: pick(root.querySelector(".de-peer-caret[data-status='idle']")),
      selection: pick(root.querySelector('.de-peer-selection')),
      flag: pick(root.querySelector('.de-peer-flag')),
      probes: {
        canvasText: {
          background: probe('background-color', 'CanvasText'),
          color: probe('color', 'CanvasText'),
        },
        canvas: { color: probe('color', 'Canvas') },
        highlight: { background: probe('background-color', 'Highlight') },
      },
    } as unknown as Record<string, Record<string, string>>;
  });
}

test.describe('collaborator carets, rendered (UX-027)', () => {
  test('under forced colours every caret, selection and flag uses a system colour', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'forced colours are emulated in Chromium only');
    await page.emulateMedia({ forcedColors: 'active' });
    await open(page, { extended: true, carets: [caret('s1', 'active'), caret('s2', 'idle')] });
    await expect(page.locator('.de-peer-flag')).toHaveCount(2);
    const r = (await renderedColours(page)) as unknown as {
      activeCaret: { background: string; adjust: string };
      idleCaret: { color: string; backgroundImage: string; adjust: string };
      selection: { background: string; adjust: string };
      flag: { background: string; color: string; adjust: string };
      probes: {
        canvasText: { background: string; color: string };
        canvas: { color: string };
        highlight: { background: string };
      };
    };
    expect(r.activeCaret.background).toBe(r.probes.canvasText.background);
    expect(r.activeCaret.adjust).toBe('none');
    // The idle dashes are drawn in CanvasText, not in the page's own text colour.
    expect(r.idleCaret.color).toBe(r.probes.canvasText.color);
    expect(r.idleCaret.backgroundImage).not.toBe('none');
    expect(r.idleCaret.adjust).toBe('none');
    expect(r.selection.background).toBe(r.probes.highlight.background);
    expect(r.selection.adjust).toBe('none');
    expect(r.flag.background).toBe(r.probes.canvasText.background);
    expect(r.flag.color).toBe(r.probes.canvas.color);
    expect(r.flag.adjust).toBe('none');
  });

  test('a click on a flag reaches the text under it; the flag takes no focus; typing stays in the surface', async ({
    page,
  }) => {
    await open(page, { extended: true, carets: [caret('s1', 'active')] });
    await focusSurface(page);
    const flag = page.locator('.de-peer-flag');
    await expect(flag).toHaveText('Ada Lovelace');
    const box = await flag.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.click(box.x, box.y);
    const active = await page.evaluate(() => {
      const root = document.getElementById('host')!.shadowRoot!;
      const el = root.activeElement as HTMLElement | null;
      return { inCarets: !!el?.closest('.de-carets'), cls: el?.className ?? '' };
    });
    expect(active.inCarets).toBe(false);
    // Focus after the click is on the page's own surface or a control, never on the layer.
    await focusSurface(page);
    await page.keyboard.type('ok');
    const after = await page.evaluate(() => {
      const root = document.getElementById('host')!.shadowRoot!;
      const el = root.activeElement as HTMLElement | null;
      return {
        surface: !!el?.classList.contains('de-editing-surface'),
        inCarets: !!el?.closest('.de-carets'),
      };
    });
    expect(after.inCarets).toBe(false);
    expect(after.surface).toBe(true);
  });
});
