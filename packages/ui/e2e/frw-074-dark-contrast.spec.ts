/**
 * Lane V-FRW-073-089: FRW-074 criterion 3 in the dark theme. The role marker's shape must reach
 * 3:1 against the surface it sits on (WCAG 2.x non-text contrast). The fix is in shell.css
 * (`.de-shell[data-theme='dark'] .de-role-icon`, ADR 0343). The ratio is measured the same way as
 * frw-074-markers.spec.ts, and this file also reports the measured value in the failure message.
 * Run from the repository root with
 * `pnpm exec playwright test -c packages/ui/playwright.config.ts packages/ui/e2e/frw-074-dark-contrast.spec.ts`
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

async function markerRatio(
  page: Page,
  id: string,
): Promise<{ ratio: number; shape: string; surface: string }> {
  return page.locator(`[data-field-row="${id}"] .de-role-icon`).evaluate((icon) => {
    // Chromium serialises a color-mix() result as color(srgb r g b) with channels in 0..1.
    const parse = (s: string): number[] | null => {
      const srgb = /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(s);
      if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255];
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

test.describe('role markers in the dark theme (FRW-074 criterion 3, lane V-FRW-073-089)', () => {
  test('the author and landlord shapes reach 3:1 against the dark surface', async ({
    page,
    browserName,
  }) => {
    await open(page, { extended: true, fill: ROLES, theme: 'dark' });
    await page
      .getByRole('region', { name: 'Filling in' })
      .getByRole('button', { name: 'What is left' })
      .click();
    for (const id of ['m1', 'o1']) {
      await expect(page.locator(`[data-field-row="${id}"] .de-role-icon`)).toBeVisible();
      const { ratio, shape, surface } = await markerRatio(page, id);
      expect(
        ratio,
        `${browserName} dark: marker ${id} paints ${shape} on ${surface}, ratio ${ratio.toFixed(2)}`,
      ).toBeGreaterThanOrEqual(3);
    }
  });
});
