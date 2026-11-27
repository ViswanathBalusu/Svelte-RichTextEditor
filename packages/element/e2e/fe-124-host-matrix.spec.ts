/**
 * FE-124 criterion 1: a demo host in each of React, Angular, Vue, SvelteKit and plain HTML hosts the
 * element, the editor loads, and a person can edit in it. Each framework host (demo/hosts/<name>)
 * is its own application with its own copy of the framework: it loads the element's bundle on
 * demand, renders `<doc-editor>` with a document and a backend, and has a button of its own. The
 * test reads `window.__host` for the loading and the framework's version, waits for `de-ready`,
 * types into the first paragraph, checks that the text reaches the document and that the host's
 * own button still works, and that no page error was raised.
 *
 * Run with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-124-host-matrix.spec.ts`
 * (port from DOCEDIT_DEMO_PORT).
 */
import { expect, test, type Page } from '@playwright/test';

interface HostStatus {
  framework: string;
  version: string;
  loaded: boolean;
  rendered: boolean;
  ready: boolean;
  error: string | null;
}

const HOSTS = [
  { name: 'react', url: '/pages/host-react.html' },
  { name: 'vue', url: '/pages/host-vue.html' },
  { name: 'angular', url: '/pages/host-angular.html' },
  { name: 'sveltekit', url: '/hosts/sveltekit/index.html' },
] as const;

const status = (page: Page): Promise<HostStatus | null> =>
  page.evaluate(() => (window as unknown as { __host?: HostStatus }).__host ?? null);

for (const host of HOSTS) {
  test(`${host.name}: the host renders the element, the editor loads and edits`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(host.url);

    // The element's bundle was imported on demand and the framework drew its own UI and the tag.
    await expect.poll(async () => (await status(page))?.ready, { timeout: 30_000 }).toBe(true);
    const s = (await status(page))!;
    expect(s).toMatchObject({ framework: host.name, loaded: true, rendered: true, error: null });
    expect(s.version).not.toBe('');
    await expect(page.locator('doc-editor')).toHaveCount(1);
    await expect(page.locator('doc-editor[data-test="host"]')).toHaveAttribute('doc-id', /.+/);

    // The editor edits: a typed word reaches the body.
    const paragraph = page.locator('doc-editor .de-editing-surface p').first();
    await expect(paragraph).toBeVisible();
    await paragraph.click();
    await page.keyboard.type(`Hosted by ${host.name}`);
    await expect(page.locator('doc-editor .de-editing-surface')).toContainText(
      `Hosted by ${host.name}`,
    );

    // The host's own framework still works beside the editor.
    await expect(page.locator('#host-clicked')).toHaveCount(0);
    await page.locator('#host-button').click();
    await expect(page.locator('#host-clicked')).toHaveText('Clicked 1 times');
    // And the click did not take the typed text away.
    await expect(page.locator('doc-editor .de-editing-surface')).toContainText(
      `Hosted by ${host.name}`,
    );
    expect((await status(page))?.error).toBeNull();
    expect(errors).toEqual([]);
  });
}

test('plain HTML: a page with no framework hosts the element, the editor loads and edits', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/pages/host-plain.html');
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as unknown as { __hostLoader?: { mounted: boolean; error: string | null } })
              .__hostLoader,
        ),
      { timeout: 30_000 },
    )
    .toMatchObject({ mounted: true, error: null });
  const paragraph = page.locator('doc-editor .de-editing-surface p').first();
  await paragraph.click();
  await page.keyboard.type('Hosted by plain HTML');
  await expect(page.locator('doc-editor .de-editing-surface')).toContainText(
    'Hosted by plain HTML',
  );
  expect(errors).toEqual([]);
});
