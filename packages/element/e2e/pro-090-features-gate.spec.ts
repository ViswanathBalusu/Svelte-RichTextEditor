/**
 * PRO-090 criterion 3 (lane w5): given a `backend` whose `features` set lacks a feature, when the
 * element renders, the controls for that feature are not shown. The feature checked is `presence`
 * (the presence avatars in the header, UX-026, shown only when the backend has the feature and
 * another person is in the document).
 *
 * Two `<doc-editor>` elements share the embed page's document: `ada` (the element under test, with
 * `presence` removed from its features when `hidePresence` is set) and `bob` (always normal, so that
 * `ada` has a peer to show). The avatars are counted inside `ada`'s element only. The positive
 * control runs the same page with `presence` left in, so an empty result is not a vacuous pass.
 * Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts e2e/pro-090-features-gate.spec.ts`.
 */
import { type Page, expect, test } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';

/**
 * Mounts a `<doc-editor>` for `sub` with `data-test` set to `sub`. The backend is a proxy: methods run
 * on the real backend, and `features` reports the negotiated set, minus `presence` when `hide`.
 */
async function mount(page: Page, sub: string, hide: boolean): Promise<void> {
  await page.evaluate(
    async ({ sub, hide }) => {
      const e = (window as unknown as { __embed: Record<string, unknown> }).__embed as unknown as {
        backend(sub: string, role: string): object;
        docId: string;
      };
      const backend = e.backend(sub, 'editor') as Record<PropertyKey, unknown> & {
        features: ReadonlySet<string>;
      };
      const wrapper = new Proxy(backend, {
        get(target, prop) {
          if (prop === 'features') {
            const real = target.features;
            return hide ? new Set([...real].filter((f) => f !== 'presence')) : real;
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function'
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      });
      const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
      el.dataset['test'] = sub;
      const ready = new Promise<void>((resolve, reject) => {
        el.addEventListener('de-ready', () => resolve(), { once: true });
        el.addEventListener(
          'de-error',
          (ev) => reject(new Error(JSON.stringify((ev as CustomEvent).detail))),
          { once: true },
        );
      });
      el.backend = wrapper;
      el.setAttribute('doc-id', e.docId);
      document.getElementById('mount')!.append(el);
      await ready;
    },
    { sub, hide },
  );
}

test('PRO-090: a backend without the presence feature shows no presence controls', async ({
  page,
}) => {
  await openEmbed(page);
  await mount(page, 'ada', true);
  await mount(page, 'bob', false);
  const ada = 'doc-editor[data-test="ada"]';
  await expect(page.locator(`${ada} .de-header-actions`)).toBeVisible();
  // Give a late presence render time to appear before counting.
  await page.waitForTimeout(500);
  await expect(page.locator(`${ada} .de-avatars`)).toHaveCount(0);
});

test('PRO-090: with the presence feature, the presence avatars are shown (positive control)', async ({
  page,
}) => {
  await openEmbed(page);
  await mount(page, 'ada', false);
  await mount(page, 'bob', false);
  const ada = 'doc-editor[data-test="ada"]';
  await expect(page.locator(`${ada} .de-header-actions`)).toBeVisible();
  await expect(page.locator(`${ada} .de-avatars`)).toHaveCount(1);
});
