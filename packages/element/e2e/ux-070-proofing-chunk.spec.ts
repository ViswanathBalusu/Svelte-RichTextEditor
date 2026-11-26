/**
 * The proofing code is a chunk of its own (UX-070, criterion 2; lane w3).
 *
 * The page `pages/lib.html` loads the distributable (`/lib/doc-editor.js`) by URL, as a host does.
 * The request trace of the page is read from the first navigation: with a backend that has no
 * proofing port no script under `/lib/` names the proofing controller and none of the scripts
 * fetched holds its code; with a backend that has a port, the `proofing-controller-*.js` chunk is
 * requested once, holds the controller and the findings are drawn.
 *
 * Run from the repository root with
 * `DOCEDIT_DEMO_PORT=57481 pnpm exec playwright test -c packages/element/playwright.config.ts ux-070-proofing-chunk`.
 */
import { expect, test, type Page } from '@playwright/test';
import { openLib } from './embed-helpers.ts';

/**
 * The definition of the controller's 	extChanged method, which only its chunk holds (the core calls
 * the method, and a call has no body). The build names the chunk after its package, ngine-<hash>.js,
 * so the chunk is found by this and not by its name.
 */
const CONTROLLER = /textChanged\(\)\s*\{/;

interface Fetched {
  url: string;
  body: string;
}

function trace(page: Page): Promise<Fetched>[] {
  const fetched: Promise<Fetched>[] = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith('/lib/') || !url.pathname.endsWith('.js')) return;
    fetched.push(
      response
        .text()
        .then((body) => ({ url: url.pathname, body }))
        .catch(() => ({ url: url.pathname, body: '' })),
    );
  });
  return fetched;
}

async function mount(page: Page, name: string, withPort: boolean): Promise<void> {
  await page.evaluate(
    async ({ name: dataTest, withPort: port }) => {
      const lib = (
        window as unknown as {
          __lib: { docId: string; backend(sub: string): Record<string, unknown> };
        }
      ).__lib;
      const backend = lib.backend('ada');
      const proofing = {
        check(request: { blocks: { blockId: string; text: string }[] }) {
          const found: unknown[] = [];
          for (const b of request.blocks)
            for (
              let at = b.text.indexOf('Remote');
              at !== -1;
              at = b.text.indexOf('Remote', at + 1)
            )
              found.push({
                blockId: b.blockId,
                from: at,
                to: at + 6,
                kind: 'spelling',
                message: 'Unknown word',
                suggestions: ['Remove'],
              });
          return Promise.resolve(found);
        },
        addWord: () => Promise.resolve(),
      };
      const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
      el.dataset['test'] = dataTest;
      const ready = new Promise<void>((resolve) =>
        el.addEventListener('de-ready', () => resolve(), { once: true }),
      );
      el.backend = new Proxy(backend, {
        get: (target, key) => {
          if (key === 'proofing') return port ? proofing : undefined;
          const value = Reflect.get(target, key, target) as unknown;
          return typeof value === 'function'
            ? (value as (...a: unknown[]) => unknown).bind(target)
            : value;
        },
      });
      el.setAttribute('doc-id', lib.docId);
      document.getElementById('mount')!.append(el);
      await ready;
    },
    { name, withPort },
  );
}

test.describe('the proofing chunk (UX-070, criterion 2)', () => {
  test('is not requested at start, and is requested once when a proofing port is attached', async ({
    page,
  }) => {
    const fetched = trace(page);
    await openLib(page);
    await page.evaluate(() =>
      (window as unknown as { __lib: { load(): Promise<unknown> } }).__lib.load(),
    );

    // An editor without a proofing port starts and is usable; nothing names the controller.
    await mount(page, 'plain', false);
    await expect(page.locator('doc-editor[data-test="plain"] .de-editing-surface')).toBeVisible();
    const start = await Promise.all(fetched);
    expect(start.some((s) => s.url.endsWith('/doc-editor.js'))).toBe(true);
    expect(start.filter((s) => CONTROLLER.test(s.body))).toEqual([]);

    // The controller's chunk is the one that holds `ProofingController`'s own wording: a finding's
    // `kind` is read as `spelling` or `grammar` there, and a port that answers is reported as checking.
    const before = fetched.length;
    await mount(page, 'proofed', true);
    await expect(
      page
        .locator('doc-editor[data-test="proofed"] .de-editing-surface [data-de-finding]', {
          hasText: 'Remote',
        })
        .first(),
    ).toBeVisible();
    const later = await Promise.all(fetched.slice(before));
    const chunks = later.filter((s) => CONTROLLER.test(s.body));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.url.startsWith('/lib/chunks/')).toBe(true);

    // A second editor with a port asks for nothing more.
    const again = fetched.length;
    await mount(page, 'proofed-again', true);
    const rest = await Promise.all(fetched.slice(again));
    expect(rest.filter((s) => CONTROLLER.test(s.body))).toEqual([]);
  });
});
