/**
 * Collaborators' carets stay on their text when the interface mirrors (UX-065 criterion 5; lane
 * V-UX-061-075).
 *
 * The core reports caret rectangles in physical coordinates, from the left (src/components/
 * Carets.svelte). The layer `.de-carets` is `dir="ltr"` and places each caret with
 * `inset-inline-start`, which in an ltr box is the physical left. So a caret the core maps to
 * 24 px from the left of the body must land 24 px from the left of the body in `en-GB` and in the
 * right-to-left `ar-XB`, and a caret mapped near the right edge must stay near the right edge in
 * both. This test does not change the core: it checks that the layer itself does not mirror.
 *
 * Method. The harness mounts with no carets, the test reads the editing surface's box, then sets
 * two carets through the fake core (`setCarets`) at physical offsets from the surface's left edge.
 * It reads each caret's box and the box of its flag, and compares offsets from the surface. The
 * caret offsets are the given ones in both locales; the surface itself is on the other side of the
 * page in `ar-XB` (checked as a precondition, so the comparison is not vacuous).
 *
 * Not covered: how the core maps a logical position to physical coordinates in a right-to-left
 * paragraph (that is the core's, and the story's Notes leave the coordinate system undecided).
 *
 * Run with `DOCEDIT_UI_PORT=56293 pnpm exec playwright test -c packages/ui/playwright.config.ts ux-065-carets-rtl --project=chromium`.
 */
import type { Page } from '@playwright/test';
import { expect, harness, open, test } from './helpers.ts';

const NEAR_START = 24;
const NEAR_END = 40;

interface Box {
  left: number;
  top: number;
  width: number;
}

async function boxes(
  page: Page,
  session: string,
): Promise<{ surface: Box; caret: Box; flag: Box }> {
  return page.evaluate((s) => {
    const root = document.getElementById('host')!.shadowRoot!;
    const pick = (el: Element | null): Box => {
      const r = el!.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width };
    };
    return {
      surface: pick(root.querySelector('.de-editing-surface')),
      caret: pick(root.querySelector(`.de-peer-caret[data-session="${s}"]`)),
      flag: pick(root.querySelector(`.de-peer-caret[data-session="${s}"] .de-peer-flag`)),
    };
  }, session);
}

for (const locale of ['en-GB', 'ar-XB']) {
  test.describe(`carets on their text in ${locale} (UX-065, criterion 5)`, () => {
    test('a caret keeps its physical offset from the page text when the interface mirrors', async ({
      page,
      browserName,
    }) => {
      test.skip(
        browserName !== 'chromium',
        'the placement is measured in Chromium (one engine is enough for the layer geometry)',
      );
      const h = await open(page, { extended: true, locale });
      await harness(page).frames(2);
      await h.setCarets([
        {
          session: 'sNear',
          user: 'u-near',
          name: 'Ada Lovelace',
          status: 'active',
          caret: { x: NEAR_START, y: 40, width: 1, height: 18 },
          selection: [],
        },
        {
          session: 'sFar',
          user: 'u-far',
          name: 'Grace Hopper',
          status: 'active',
          caret: null,
          selection: [],
        },
      ]);
      // A caret mapped near the right edge of the body: its physical x from the surface's left.
      const surfaceWidth = (await boxes(page, 'sNear')).surface.width;
      await h.setCarets([
        {
          session: 'sNear',
          user: 'u-near',
          name: 'Ada Lovelace',
          status: 'active',
          caret: { x: NEAR_START, y: 40, width: 1, height: 18 },
          selection: [],
        },
        {
          session: 'sFar',
          user: 'u-far',
          name: 'Grace Hopper',
          status: 'active',
          caret: { x: surfaceWidth - NEAR_END, y: 40, width: 1, height: 18 },
          selection: [],
        },
      ]);
      await expect(page.locator('.de-peer-caret[data-session="sFar"]')).toHaveCount(1);

      const near = await boxes(page, 'sNear');
      const far = await boxes(page, 'sFar');
      const direction = await page.evaluate(() => {
        const root = document.getElementById('host')!.shadowRoot!;
        return getComputedStyle(root.querySelector('.de-shell')!).direction;
      });
      test.info().annotations.push({
        type: 'caret-offsets',
        description: JSON.stringify({
          locale,
          shellDirection: direction,
          surfaceWidth,
          nearOffset: near.caret.left - near.surface.left,
          farOffset: far.caret.left - far.surface.left,
          flagAtCaret: Math.round(near.flag.left - near.caret.left),
          surfaceLeftInViewport: near.surface.left,
        }),
      });

      // The shell mirrors as expected: the precondition that makes the comparison meaningful.
      expect(direction).toBe(locale === 'ar-XB' ? 'rtl' : 'ltr');
      // Physical offsets from the page text are the ones the core gave, in either locale.
      expect(Math.round(near.caret.left - near.surface.left)).toBe(NEAR_START);
      expect(Math.round(far.caret.left - far.surface.left)).toBe(surfaceWidth - NEAR_END);
      // The caret stays on its line: same top offset from the surface.
      expect(Math.round(near.caret.top - near.surface.top)).toBe(40);
      // The flag stays at the caret, not mirrored to the other side of it.
      expect(Math.abs(near.flag.left - near.caret.left)).toBeLessThan(near.surface.width);
    });
  });
}
