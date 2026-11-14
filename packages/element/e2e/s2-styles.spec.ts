/**
 * Spike S2 (SPK-015): styles under a policy without 'unsafe-inline' (02 §3; FE-014, FE-015).
 *
 * - Probes: which ways of setting a style from script apply and which raise a violation, in the
 *   document and in a shadow root (demo/probe-page.ts).
 * - ProseMirror's own `style.cssText` writes: a decoration with a `style` attribute
 *   (prosemirror-view appends it with `style.cssText +=`) and the drop cursor (prosemirror-dropcursor
 *   assigns `style.cssText`).
 * - The nonce-carrying `<style>` fallback of 02 §3, against the normal adopted-sheet path.
 */
import { expect, test } from '@playwright/test';
import { SPIKE_IDS, encodePolicy, record, runId } from './helpers.ts';
import { collect, harness, openS2, policy, summary } from './s2-helpers.ts';

const STYLE_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self' 'nonce-{nonce}'; report-uri {report}";

test('style probes in the document and in a shadow root', async ({ page, request }) => {
  const run = runId();
  await page.goto(`/pages/probe.html?run=${run}&csp=${encodePolicy(STYLE_POLICY)}`);
  await page.waitForFunction(
    () => 'run' in ((window as unknown as { __probe?: object }).__probe ?? {}),
  );
  const names = await page.evaluate(
    () => (window as unknown as { __probe: { names: string[] } }).__probe.names,
  );
  const results: Record<string, { applied: boolean; violations: string[] }> = {};
  for (const where of ['document', 'shadow'] as const) {
    for (const name of names) {
      const before = await page.evaluate(
        () =>
          (window as unknown as { __spike: { violations: unknown[] } }).__spike.violations.length,
      );
      const applied = await page.evaluate(
        ([n, w]) =>
          (window as unknown as { __probe: { run(n: string, w: string): boolean } }).__probe.run(
            n,
            w,
          ),
        [name, where] as const,
      );
      await page.waitForTimeout(150);
      const violations = await page.evaluate(
        (from) =>
          (
            window as unknown as { __spike: { violations: Array<{ directive: string }> } }
          ).__spike.violations
            .slice(from)
            .map((v) => v.directive),
        before,
      );
      results[`${where}:${name}`] = { applied, violations };
    }
  }
  const collected = await collect(page, request, run, 300);
  record('s2-style-probes', { results, reports: summary(collected) });

  for (const where of ['document', 'shadow']) {
    // CSSOM property writes and constructable sheets are not inline styles.
    for (const name of ['styleProperty', 'setProperty', 'constructable', 'styleWithNonce'])
      expect(results[`${where}:${name}`], `${where}:${name}`).toEqual({
        applied: true,
        violations: [],
      });
    // A style attribute and a <style> without the nonce are inline styles.
    expect(results[`${where}:setAttribute`]!.applied, `${where}:setAttribute`).toBe(false);
    expect(results[`${where}:setAttribute`]!.violations.length).toBeGreaterThan(0);
    expect(results[`${where}:styleWithoutNonce`]!.applied, `${where}:styleWithoutNonce`).toBe(
      false,
    );
    expect(results[`${where}:styleWithoutNonce`]!.violations.length).toBeGreaterThan(0);
  }
  // The canvas filter (which PDF.js sets) is not a style write and raises nothing.
  for (const where of ['document', 'shadow'])
    expect(results[`${where}:canvasFilter`], `${where}:canvasFilter`).toEqual({
      applied: true,
      violations: [],
    });
});

test('ProseMirror writes style.cssText for style decorations and the drop cursor', async ({
  page,
  request,
}) => {
  const run = runId();
  await openS2(page, run, policy({ 'trusted-types': 'ProseMirrorClipboard' }));
  const h = harness(page);
  const decorated = await h.styleDecoration(
    'Remote target',
    'outline-color: rgb(9, 8, 7); outline-style: solid',
  );
  expect(decorated).toBe(true);
  const decoration = await page.evaluate(() => {
    const span = document
      .querySelector('doc-editor')!
      .shadowRoot!.querySelector('.de-style-decoration') as HTMLElement;
    return {
      cssText: span.style.cssText,
      applied: getComputedStyle(span).outlineColor === 'rgb(9, 8, 7)',
    };
  });
  const dropcursor = await page.evaluate(async () => {
    const root = document.querySelector('doc-editor')!.shadowRoot!;
    const surface = root.querySelector('.ProseMirror') as HTMLElement;
    const target = surface.querySelector('p') as HTMLElement;
    const rect = target.getBoundingClientRect();
    const event = new DragEvent('dragover', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + 5,
      clientY: rect.top + 5,
      dataTransfer: new DataTransfer(),
    });
    target.dispatchEvent(event);
    await new Promise((r) => setTimeout(r, 50));
    // prosemirror-dropcursor appends its element to the view's offsetParent, which may be outside
    // the shadow root: look in both trees.
    const cursor = [...root.querySelectorAll('div'), ...document.querySelectorAll('div')].find(
      (d) => d.style.zIndex === '50' && d.style.pointerEvents === 'none',
    );
    return cursor
      ? {
          found: true,
          position: getComputedStyle(cursor).position,
          cssText: cursor.style.cssText,
          inShadowRoot: cursor.getRootNode() === root,
          parent: cursor.parentElement?.localName ?? null,
        }
      : { found: false, position: null, cssText: null, inShadowRoot: null, parent: null };
  });
  const collected = await collect(page, request, run);
  record('s2-prosemirror-csstext', { decoration, dropcursor, violations: summary(collected) });
  expect(decoration.applied).toBe(true);
  expect(dropcursor.found).toBe(true);
  expect(dropcursor.position).toBe('absolute');
  expect(summary(collected)).toEqual([]);
  expect(await h.nodeText(SPIKE_IDS.after)).toBe('Remote target paragraph.');
});

for (const variant of [
  'adopted',
  'nonce fallback',
  'fallback without the nonce in the policy',
] as const) {
  test(`component styles: ${variant}`, async ({ page, request }) => {
    const run = runId();
    const styleSrc =
      variant === 'fallback without the nonce in the policy' ? "'self'" : "'self' 'nonce-{nonce}'";
    await openS2(
      page,
      run,
      policy({ 'style-src': styleSrc, 'trusted-types': 'ProseMirrorClipboard' }),
      variant === 'adopted' ? '' : '&fallback',
    );
    const seen = await page.evaluate(() => {
      const el = document.querySelector('doc-editor') as unknown as HTMLElement & {
        stylePath: string;
      };
      const root = el.shadowRoot!;
      const toolbar = root.querySelector('.de-toolbar')!;
      const region = root.querySelector('.de-region')!;
      return {
        stylePath: el.stylePath,
        styleElements: root.querySelectorAll('style').length,
        adopted: root.adoptedStyleSheets.length,
        toolbarDisplay: getComputedStyle(toolbar).display,
        regionBorder: getComputedStyle(region).borderInlineStartWidth,
      };
    });
    const collected = await collect(page, request, run);
    record(`s2-component-styles-${variant.replaceAll(' ', '-')}`, {
      seen,
      violations: summary(collected),
    });
    if (variant === 'adopted') {
      expect(seen).toEqual({
        stylePath: 'adopted',
        styleElements: 0,
        adopted: 1,
        toolbarDisplay: 'flex',
        regionBorder: '3px',
      });
      expect(summary(collected)).toEqual([]);
    } else if (variant === 'nonce fallback') {
      expect(seen).toEqual({
        stylePath: 'nonce-style',
        styleElements: 1,
        adopted: 0,
        toolbarDisplay: 'flex',
        regionBorder: '3px',
      });
      expect(summary(collected)).toEqual([]);
    } else {
      // Without the nonce in the policy the fallback is blocked: unstyled, and reported.
      expect(seen.stylePath).toBe('nonce-style');
      expect(seen.toolbarDisplay).toBe('block');
      expect(summary(collected).some((v) => v.includes('style-src'))).toBe(true);
    }
  });
}
