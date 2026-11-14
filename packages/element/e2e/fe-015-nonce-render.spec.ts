/**
 * FE-015 criterion 2 (lane U-FE-001-016): under a policy that allows styles only with the nonce,
 * the nonce-carrying `<style>` fallback renders the editor the same as the adopted-sheet path, and
 * reports no violation. Uses the S2 page (openS2, as s2-styles.spec.ts does) and compares element
 * screenshots pixel for pixel between the two paths in the same browser.
 */
import { expect, test } from '@playwright/test';
import { runId } from './helpers.ts';
import { collect, openS2, policy, summary } from './s2-helpers.ts';

const NONCE_ONLY = {
  'style-src': "'self' 'nonce-{nonce}'",
  'trusted-types': 'ProseMirrorClipboard',
};

// Attribution (lane V-FE-001-016, 2026-11-13): the `style-src-elem` inline report seen in WebKit is
// not the editor's. Probed in WebKit with the same policy: no violation while the editor is mounted
// and before any screenshot, on either path; the single report appears only after Playwright's
// `element.screenshot()` step, which injects its own inline style there. So the violation check
// runs before the screenshot, and the pixel comparison below remains.
test('FE-015 nonce fallback renders identically to the adopted sheet', async ({
  page,
  request,
}) => {
  const shots: Buffer[] = [];
  const paths: string[] = [];
  // A fresh page for each path, so that one run's reports and state cannot leak into the other.
  for (const extra of ['', '&fallback'] as const) {
    const p = await page.context().newPage();
    const run = runId();
    await openS2(p, run, policy(NONCE_ONLY), extra);
    const el = p.locator('doc-editor');
    await expect(el.locator('.de-toolbar')).toBeVisible();
    paths.push(
      await p.evaluate(
        () => (document.querySelector('doc-editor') as unknown as { stylePath: string }).stylePath,
      ),
    );
    // Violations are read before the screenshot: Playwright's screenshot injects its own inline
    // <style> in WebKit, which this policy reports (see the note above).
    const collected = await collect(p, request, run);
    expect(summary(collected)).toEqual([]);
    shots.push(await el.screenshot({ caret: 'initial' }));
    await p.close();
  }
  expect(paths).toEqual(['adopted', 'nonce-style']);
  expect(shots[1]!.equals(shots[0]!)).toBe(true);
});
