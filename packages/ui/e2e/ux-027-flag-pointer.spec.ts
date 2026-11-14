/**
 * UX-027 criterion 5 (lane V-UX-016-030): a name flag that overlaps text neither takes focus nor
 * blocks pointer events on the text. The rendered check asks the shadow root which element sits
 * under the centre of each flag and each caret: it must be the page's own text, never the carets
 * layer, and the flag's computed `pointer-events` must not be `auto`. Run from the repository root
 * with `pnpm exec playwright test -c packages/ui/playwright.config.ts ux-027-flag-pointer`.
 */
import { expect, focusSurface, open, test } from './helpers.ts';

const caret = (session: string, name: string) => ({
  session,
  user: `u-${session}`,
  name,
  status: 'active' as const,
  caret: { x: 40, y: 4, width: 0, height: 18 },
  selection: [{ x: 60, y: 4, width: 50, height: 18 }],
});

test.describe('name flags do not block the text (UX-027 criterion 5)', () => {
  test('the element under each flag and caret is the text, not the carets layer', async ({
    page,
  }) => {
    await open(page, {
      extended: true,
      carets: [caret('s1', 'Ada Lovelace'), caret('s2', 'Grace Hopper')],
    });
    await focusSurface(page);
    await expect(page.locator('.de-peer-flag')).toHaveCount(2);
    const probes = await page.evaluate(() => {
      const root = document.getElementById('host')!.shadowRoot!;
      const targets = [...root.querySelectorAll('.de-peer-flag, .de-peer-caret')];
      return targets.map((el) => {
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        const hit = root.elementFromPoint(x, y) as Element | null;
        return {
          kind: el.className,
          pointerEvents: getComputedStyle(el).pointerEvents,
          hitInCarets: !!hit?.closest('.de-carets'),
          hitIsSurface: !!hit?.closest('.de-editing-surface'),
        };
      });
    });
    expect(probes.length).toBeGreaterThan(0);
    for (const p of probes) {
      expect(p.pointerEvents, p.kind).toBe('none');
      expect(p.hitInCarets, `hit under ${p.kind}`).toBe(false);
    }
    // The page text stays the target under the flags: at least one probe lands on the surface.
    expect(probes.some((p) => p.hitIsSurface)).toBe(true);
  });

  test('a click where a flag overlaps the text places the caret in the text', async ({ page }) => {
    await open(page, { extended: true, carets: [caret('s1', 'Ada Lovelace')] });
    await focusSurface(page);
    const flag = page.locator('.de-peer-flag');
    await expect(flag).toHaveText('Ada Lovelace');
    const box = await flag.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    const under = await page.evaluate(
      ([x, y]) => {
        const root = document.getElementById('host')!.shadowRoot!;
        const hit = root.elementFromPoint(x, y) as Element | null;
        return {
          inCarets: !!hit?.closest('.de-carets'),
          inPage: !!hit?.closest('.de-page, .de-editing-surface'),
        };
      },
      [box.x, box.y] as const,
    );
    expect(under.inCarets).toBe(false);
    expect(under.inPage).toBe(true);
    await page.mouse.click(box.x, box.y);
    const focusInCarets = await page.evaluate(() => {
      const root = document.getElementById('host')!.shadowRoot!;
      return !!(root.activeElement as HTMLElement | null)?.closest('.de-carets');
    });
    expect(focusInCarets).toBe(false);
  });
});
