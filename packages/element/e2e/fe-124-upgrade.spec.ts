/**
 * FE-124 criterion 2 (lane V-FE-113-128): a host that imports the bundle on demand, after the
 * element is already in the page, gets the element upgraded and working. The element is created
 * and mounted before the library is imported (so the element is an unupgraded `HTMLElement` until
 * then); after the import, it is an instance of the library's class, it reaches `de-ready`, and a
 * typed character reaches the document.
 *
 * Runs on the library build (pages/lib.html, demo/lib-page.ts): the bundle is the one a host loads.
 * Run with `pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-124-upgrade.spec.ts`
 * (port from DOCEDIT_DEMO_PORT).
 */
import { expect, test } from '@playwright/test';

test('an element mounted before the on-demand import is upgraded and edits', async ({ page }) => {
  await page.goto('/pages/lib.html');
  await page.waitForFunction(() => '__lib' in window);

  const before = await page.evaluate(async () => {
    const lib = (
      window as unknown as {
        __lib: { backend(sub: string): unknown; docId: string; load(): Promise<unknown> };
      }
    ).__lib;
    const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
    el.setAttribute('doc-id', lib.docId);
    el.backend = lib.backend('ada');
    document.getElementById('mount')!.append(el);
    // Not yet upgraded: no class is defined, and the element has no shadow root of its own.
    return {
      defined: customElements.get('doc-editor') !== undefined,
      shadow: el.shadowRoot !== null,
    };
  });
  expect(before).toEqual({ defined: false, shadow: false });

  const ready = page.evaluate(async () => {
    const lib = (window as unknown as { __lib: { load(): Promise<Record<string, unknown>> } })
      .__lib;
    const ready = new Promise<void>((resolve, reject) => {
      const el = document.querySelector('doc-editor')!;
      el.addEventListener('de-ready', () => resolve(), { once: true });
      el.addEventListener(
        'de-error',
        (e) => reject(new Error(JSON.stringify((e as CustomEvent).detail))),
        { once: true },
      );
    });
    const mod = await lib.load();
    const C = mod['DocEditorElement'] as CustomElementConstructor;
    const el = document.querySelector('doc-editor')!;
    await ready;
    return {
      upgraded: el instanceof C,
      shadow: el.shadowRoot?.mode ?? null,
    };
  });
  await expect(ready).resolves.toEqual({ upgraded: true, shadow: 'open' });

  // It works: a typed character reaches the editing surface of the same instance.
  const heading = page.locator('doc-editor .de-editing-surface h1').first();
  await heading.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' upgraded');
  await expect(heading).toContainText('upgraded');
});
