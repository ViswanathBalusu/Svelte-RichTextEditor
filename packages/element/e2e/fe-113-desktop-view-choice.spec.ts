/**
 * FE-113 criterion 2, the control case (U4 group 2, round 2 fix): on a desktop, with no touch input,
 * `view="read"` shows the read view and no editing surface. This is what makes the touch case of
 * e2e/fe-113-touch-view-choice.spec.ts mean something: the same attribute shows the web view there
 * only because the element applies the touch decision (`selectView`, src/view-select.ts, called from
 * `#viewChoice` in src/doc-editor.ts). Without that call the touch case would show the read view.
 *
 * Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts e2e/fe-113-desktop-view-choice.spec.ts --project=chromium --project=firefox --project=webkit`.
 * Each project's default desktop device is used (a fine pointer, no touch).
 */
import { expect, test } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';
import { mountWithView } from './fe-113-view-choice-helpers.ts';

test('on a desktop, view="read" shows the read view, not the web view (FE-113 control)', async ({
  page,
}) => {
  await openEmbed(page);
  const shown = await mountWithView(page, 'read');
  // The precondition: the element sees no touch input here.
  expect(shown.coarsePointer).toBe(false);
  expect(shown.readView).toBe(1);
  expect(shown.webSurface).toBe(0);
});

test('on a desktop, view="web" shows the web view (FE-113 control)', async ({ page }) => {
  await openEmbed(page);
  const shown = await mountWithView(page, 'web');
  expect(shown.coarsePointer).toBe(false);
  expect(shown.webSurface).toBe(1);
  expect(shown.readView).toBe(0);
});
