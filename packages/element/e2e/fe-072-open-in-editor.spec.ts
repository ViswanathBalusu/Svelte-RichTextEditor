/**
 * FE-072 criterion 4 (lane w1): in the read view, selecting an export diagnostic that names a block
 * opens the web view with the caret in that block when the user may edit; when the user may not edit,
 * the read view stays and says why. Run from the repository root with
 * `DOCEDIT_DEMO_PORT=57072 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-072-open-in-editor.spec.ts --project=chromium --project=firefox --project=webkit --retries=0`.
 *
 * As in fe-072-read-view.spec.ts, the embed page's mock backend gets an export port. Its job fails, so
 * no PDF is opened (a failed export lists the diagnostics too, and runs in every browser). The
 * diagnostic names the last paragraph of the demo document (`SPIKE_IDS.last`).
 */
import { expect, test, type Page } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';

interface Hooks {
  backend(sub: string, role: string): unknown;
  docId: string;
  SPIKE_IDS: { last: string };
  harness(el: Element): Promise<{
    selection(): { from: number };
    caretIn(id: string, at: 'start' | 'end'): void;
  }>;
}

/** Mounts a read view whose failed export lists one diagnostic for the last paragraph. */
async function mountRead(page: Page, sub: string, role: string): Promise<void> {
  await page.evaluate(
    async (who: { sub: string; role: string }) => {
      const e = (window as unknown as { __embed: Hooks }).__embed;
      const backend = e.backend(who.sub, who.role) as {
        features: ReadonlySet<string>;
        connect(): Promise<void>;
        exports?: unknown;
      };
      const connect = backend.connect.bind(backend);
      backend.connect = async () => {
        await connect();
        backend.features = new Set([...backend.features, 'exports']);
      };
      const job = (state: string) => ({
        id: 'job-fe072-open',
        docId: e.docId,
        state,
        progress: null,
        target: 'pdf',
        result: null,
        error: state === 'failed' ? { code: 'internal', message: 'the worker stopped' } : undefined,
        diagnostics:
          state === 'failed'
            ? [
                {
                  severity: 'warning',
                  code: 'FE072',
                  message: 'a line is too long',
                  blockId: e.SPIKE_IDS.last,
                },
              ]
            : [],
      });
      backend.exports = {
        request: async () => job('queued'),
        get: async () => job('failed'),
        cancel: async () => {},
      };
      const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
      el.dataset['test'] = 'fe-072-open';
      el.setAttribute('view', 'read');
      el.setAttribute('doc-id', e.docId);
      el.backend = backend;
      document.getElementById('mount')!.append(el);
    },
    { sub, role },
  );
  await expect(
    page.locator('doc-editor[data-test="fe-072-open"] .de-read-diagnostic-go'),
  ).toHaveText('warning: FE072: a line is too long', { timeout: 20_000 });
}

test('selecting a diagnostic opens the web view at its block for a user who may edit (FE-072 criterion 4)', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = (query: string) =>
      original(query.includes('any-pointer: coarse') ? 'not all' : query);
  });
  await openEmbed(page);
  await mountRead(page, 'ada', 'editor');
  const root = 'doc-editor[data-test="fe-072-open"]';
  // The read view has no editing surface before the selection.
  await expect(page.locator(`${root} .de-editing-surface`)).toHaveCount(0);

  await page.locator(`${root} .de-read-diagnostic-go`).click();

  await expect(page.locator(`${root} .de-editing-surface`)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(`${root} .de-read-view`)).toHaveCount(0);
  // The caret is where the editor puts it for the block: the same place as a caret placed there by hand.
  const where = await page.evaluate(async () => {
    const e = (window as unknown as { __embed: Hooks }).__embed;
    const h = await e.harness(document.querySelector('doc-editor[data-test="fe-072-open"]')!);
    const moved = h.selection().from;
    h.caretIn(e.SPIKE_IDS.last, 'start');
    return { moved, expected: h.selection().from };
  });
  expect(where.moved).toBe(where.expected);
  expect(errors).toEqual([]);
});

test('a user who may not edit stays in the read view and is told why (FE-072 criterion 4)', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openEmbed(page);
  // `bob` holds no grant on the demo document's region, so the viewer role carries no edit right.
  await mountRead(page, 'bob', 'viewer');
  const root = 'doc-editor[data-test="fe-072-open"]';

  await page.locator(`${root} .de-read-diagnostic-go`).click();

  await expect(page.locator(`${root} .de-read-jump`)).toHaveText(
    'You cannot edit this document, so this block cannot be opened in the editor.',
  );
  await expect(page.locator(`${root} .de-read-view`)).toHaveCount(1);
  await expect(page.locator(`${root} .de-editing-surface`)).toHaveCount(0);
  expect(errors).toEqual([]);
});
