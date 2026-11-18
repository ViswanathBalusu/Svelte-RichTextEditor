/**
 * FE-124 criterion 3 (lane w1): a host that renders on a server and then hydrates. The host is a
 * Svelte 5 page (demo/ssr-host): its component imports the element's entry point and contains a
 * `<doc-editor>` tag. `demo/ssr-host/prerender.ts` renders it with `svelte/server` in Node.js (the
 * build fails if that import or render throws) and writes `/ssr-host/index.html`; `client.ts`
 * hydrates it in the browser, gives the element its backend, and the test types into it.
 *
 * The test checks, in this order: the markup the server sent holds the host's content and the
 * unupgraded element tag; no page error arises while the page hydrates; hydration keeps the
 * server's element node; the element reaches `de-ready`; a typed character reaches the document;
 * and the host's own button still works after the element is running.
 *
 * Run with `pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-124-ssr-hydrate.spec.ts`
 * (port from DOCEDIT_DEMO_PORT).
 */
import { expect, test } from '@playwright/test';

interface SsrHostStatus {
  serverMarkup: boolean;
  hydrated: boolean;
  ready: boolean;
  sameNode: boolean;
  error: string | null;
}

test('the markup a server rendered is hydrated, and the element then works', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  const response = await page.goto('/ssr-host/index.html');
  // What the server sent, before any script ran.
  const sent = (await response!.text()).replace(/<!--.*?-->/g, '');
  expect(sent).toContain('Host clicks: 0');
  expect(sent).toMatch(/<doc-editor id="ssr-editor"><\/doc-editor>/);
  expect(sent).not.toContain('shadowrootmode');

  await page.waitForFunction(() => {
    const s = (window as unknown as { __ssrHost?: SsrHostStatus }).__ssrHost;
    return s !== undefined && (s.ready || s.error !== null);
  });
  const status = await page.evaluate(
    () => (window as unknown as { __ssrHost: SsrHostStatus }).__ssrHost,
  );
  expect(status).toEqual({
    serverMarkup: true,
    hydrated: true,
    ready: true,
    sameNode: true,
    error: null,
  });

  // The element, upgraded where the server left the tag, edits.
  const heading = page.locator('doc-editor#ssr-editor .de-editing-surface h1').first();
  await heading.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' after hydration');
  await expect(heading).toContainText('after hydration');

  // The host's own handlers, attached by hydration, still run beside the element.
  await page.locator('#host-button').click();
  await expect(page.locator('#host-button')).toHaveText('Host clicks: 1');
  expect(await page.locator('doc-editor').count()).toBe(1);
  expect(pageErrors).toEqual([]);
});
