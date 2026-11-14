/**
 * FE-124 criterion 5 (lane V-FE-113-128): two instances of the element on one page, next to a host
 * that uses its own Svelte 5 (demo/svelte-host, pages/svelte-host.html), do not interfere. Each
 * instance has its own document; typing in one leaves the other unchanged; the host's Svelte keeps
 * working; and no editor raises an error.
 *
 * The first instance is the one the host page mounts (demo/host-loader.ts); the second is created
 * by this test with a document and a backend from `window.__hostFixtures` (demo/host-loader.ts).
 *
 * Run with `pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-124-two-instances.spec.ts`
 * (port from DOCEDIT_DEMO_PORT).
 */
import { expect, test } from '@playwright/test';

test('two instances with two documents next to a Svelte 5 host do not interfere', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto('/pages/svelte-host.html');
  await page.waitForFunction(() => {
    const s = (
      window as unknown as {
        __hostLoader?: { mounted: boolean; error: string | null };
      }
    ).__hostLoader;
    return s !== undefined && (s.mounted || s.error !== null);
  });
  const first = await page.evaluate(
    () => (window as unknown as { __hostLoader: unknown }).__hostLoader,
  );
  expect(first).toMatchObject({ mounted: true, error: null });

  // The second instance: its own document, its own backend, mounted after the first.
  const second = await page.evaluate(async () => {
    const f = (
      window as unknown as {
        __hostFixtures: {
          newDocument(): string;
          backendFor(sub: string, id: string): unknown;
        };
      }
    ).__hostFixtures;
    const id = f.newDocument();
    const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
    el.dataset['test'] = 'second';
    const ready = new Promise<void>((resolve, reject) => {
      el.addEventListener('de-ready', () => resolve(), { once: true });
      el.addEventListener(
        'de-error',
        (e) => reject(new Error(JSON.stringify((e as CustomEvent).detail))),
        { once: true },
      );
    });
    el.backend = f.backendFor('bob', id);
    el.setAttribute('doc-id', id);
    document.querySelector('main')!.append(el);
    await ready;
    return { docId: id, count: document.querySelectorAll('doc-editor').length };
  });
  expect(second.count).toBe(2);

  const surfaces = page.locator('doc-editor .de-editing-surface');
  await expect(surfaces).toHaveCount(2);
  const firstBefore = await surfaces.nth(0).innerText();

  // Typing in the second instance changes only the second document.
  const secondHeading = page.locator('doc-editor').nth(1).locator('.de-editing-surface h1').first();
  await secondHeading.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' second instance');
  await expect(secondHeading).toContainText('second instance');
  expect(await surfaces.nth(0).innerText()).toBe(firstBefore);

  // And the other way round: typing in the first leaves the second's text as it was. The caret
  // goes to each editor's heading, which both documents allow the user to edit.
  const secondAfter = await surfaces.nth(1).innerText();
  const firstHeading = page.locator('doc-editor').nth(0).locator('.de-editing-surface h1').first();
  await firstHeading.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' first instance');
  await expect(firstHeading).toContainText('first instance');
  expect(await surfaces.nth(1).innerText()).toBe(secondAfter);
  expect(secondAfter).not.toContain('first instance');

  // The host's own Svelte keeps working alongside both instances.
  await page.locator('#host-button').click();
  await expect(page.locator('#host-clicked')).toHaveText('Clicked 1 times');

  // Both editors kept their own shadow roots, and no error reached the page.
  const roots = await page.evaluate(() =>
    [...document.querySelectorAll('doc-editor')].map((e) => e.shadowRoot?.mode ?? null),
  );
  expect(roots).toEqual(['open', 'open']);
  expect(pageErrors).toEqual([]);
});
