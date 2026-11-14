/**
 * Lane U-FRW-073-089, round 2: FRW-074 criterion 3. Role markers of form fields meet non-text
 * contrast (WCAG 2.x, 3:1) against the surface they sit on in the light, dark and high-contrast
 * themes, and under forced colours they use a system colour. The ratio is measured in the page from
 * the computed colours of the marker and of the nearest opaque background above it (the walk crosses
 * the shell's shadow root). Run from the repository root with
 * `pnpm exec playwright test -c packages/ui/playwright.config.ts packages/ui/e2e/frw-074-markers.spec.ts`
 * and `DOCEDIT_UI_PORT` set to a port in 56430 to 56439.
 */
import type { Page } from '@playwright/test';
import { expect, open, test } from './helpers.ts';

const ROLES = {
  active: true,
  roles: ['role_tenant', 'role_landlord'],
  fields: [
    {
      id: 'm1',
      label: 'Income',
      required: true,
      filled: false,
      invalid: null,
      assignee: 'role_tenant',
      role: { name: 'Tenant', color: '#0d47a1', order: 0 },
    },
    {
      id: 'o1',
      label: 'Landlord name',
      required: true,
      filled: false,
      invalid: null,
      assignee: 'role_landlord',
      role: { name: 'Landlord', color: '#b71c1c', order: 1 },
    },
  ],
};

const MIN_NON_TEXT_CONTRAST = 3;

interface Contrast {
  ratio: number;
  shape: string;
  surface: string;
}

/** The WCAG ratio of the marker's colour against the nearest opaque background above it. */
async function markerContrast(page: Page, id: string): Promise<Contrast> {
  return page.locator(`[data-field-row="${id}"] .de-role-icon`).evaluate((icon) => {
    const parse = (s: string): number[] | null => {
      const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(s);
      return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
    };
    const lum = (rgb: number[]): number => {
      const f = (c: number): number => {
        const v = c / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(rgb[0]!) + 0.7152 * f(rgb[1]!) + 0.0722 * f(rgb[2]!);
    };
    const shape = getComputedStyle(icon).backgroundColor;
    let surface = 'none';
    let el: Element | null = icon.parentElement;
    while (el) {
      const bg = getComputedStyle(el).backgroundColor;
      if (parse(bg) !== null && !/,\s*0\)$/.test(bg)) {
        surface = bg;
        break;
      }
      const parent: Element | null = el.parentElement;
      el = parent ?? (el.getRootNode() as ShadowRoot).host ?? null;
    }
    const a = parse(shape);
    const b = parse(surface);
    if (a === null || b === null) return { ratio: 0, shape, surface };
    const la = lum(a);
    const lb = lum(b);
    return { ratio: (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05), shape, surface };
  });
}

const THEMES = ['light', 'dark', 'high-contrast'] as const;

for (const theme of THEMES) {
  test.describe(`role markers in the ${theme} theme (FRW-074 criterion 3)`, () => {
    test('meet non-text contrast against their surface', async ({ page }) => {
      // Known defect, recorded in ADR 0343: the author colour #0d47a1 is about 1.8:1 on the dark surface.
      test.fail(theme === 'dark', 'dark theme: author role colours fall below 3:1 (ADR 0343)');
      await open(page, { extended: true, fill: ROLES, theme });
      await page
        .getByRole('region', { name: 'Filling in' })
        .getByRole('button', { name: 'What is left' })
        .click();
      for (const id of ['m1', 'o1']) {
        await expect(page.locator(`[data-field-row="${id}"] .de-role-icon`)).toBeVisible();
        const { ratio, shape, surface } = await markerContrast(page, id);
        expect(
          ratio,
          `${theme}: marker ${id} paints ${shape} on ${surface}, ratio ${ratio.toFixed(2)}`,
        ).toBeGreaterThanOrEqual(MIN_NON_TEXT_CONTRAST);
      }
    });
  });
}

test.describe('role markers under forced colours (FRW-074 criterion 3)', () => {
  test('use a system colour for the shape and keep it visible', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'forced colours are emulated in Chromium only');
    await page.emulateMedia({ forcedColors: 'active' });
    await open(page, { extended: true, fill: ROLES });
    await page
      .getByRole('region', { name: 'Filling in' })
      .getByRole('button', { name: 'What is left' })
      .click();
    for (const id of ['m1', 'o1']) {
      const icon = page.locator(`[data-field-row="${id}"] .de-role-icon`);
      await expect(icon).toBeVisible();
      const style = await icon.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { forced: cs.forcedColorAdjust, bg: cs.backgroundColor };
      });
      // The shell opts the icon out of forced colours and paints it CanvasText (shell.css, forced-colors block).
      expect(style.forced, `marker ${id} opts out of forced colours`).toBe('none');
      expect(style.bg).toBe('rgb(0, 0, 0)');
    }
  });
});
