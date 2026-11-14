/**
 * FE-116 criterion 4 (lane U-FE-113-128): in Safari (Playwright's WebKit engine) the editor reads the
 * selection through `Selection.getComposedRanges()`, and in browsers that have no such method it
 * does not fail. The probe wraps the native method before the page runs (addInitScript), counts the
 * calls made while the caret is moved and text is typed in the editing surface, and records each
 * browser's result in test-results/evidence/fe-116-composed-ranges.<project>.json.
 * Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts e2e/fe-116-composed-ranges.spec.ts`.
 * Criterion 4's second half (the Firefox getSelection patch recorded as a side effect) is documented
 * in packages/element/docs/policies-and-side-effects.md and is not run here.
 */
import { expect, test } from '@playwright/test';
import { SPIKE_IDS, openS1, record } from './helpers.ts';

test('the editor reads the selection with Selection.getComposedRanges where the browser has it', async ({
  page,
  browserName,
}) => {
  await page.addInitScript(() => {
    const proto = Selection.prototype as Selection & { getComposedRanges?: unknown };
    const native = proto.getComposedRanges;
    (window as unknown as { __gcr: { available: boolean; calls: number } }).__gcr = {
      available: typeof native === 'function',
      calls: 0,
    };
    if (typeof native === 'function') {
      proto.getComposedRanges = function (this: Selection, ...args: unknown[]) {
        (window as unknown as { __gcr: { calls: number } }).__gcr.calls += 1;
        return (native as (...a: unknown[]) => StaticRange[]).apply(this, args);
      };
    }
  });

  const h = await openS1(page);
  await h.caretIn(SPIKE_IDS.after, 'end');
  await page.keyboard.type('!');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.type('?');
  expect(await h.nodeText(SPIKE_IDS.after)).toContain('?!');

  const gcr = await page.evaluate(
    () => (window as unknown as { __gcr: { available: boolean; calls: number } }).__gcr,
  );
  record('fe-116-composed-ranges', { browser: browserName, ...gcr });

  if (browserName === 'webkit') {
    // Safari has the method (Safari 17 and later) and the editor must call it.
    expect(gcr.available).toBe(true);
    expect(gcr.calls).toBeGreaterThan(0);
  }
});
