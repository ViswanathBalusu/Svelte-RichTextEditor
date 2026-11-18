/**
 * The export dialog in the production element (UX-101 criteria 1, 4 and 5; lane w3, 2026-11-17).
 * The real element runs with its demo backend, to which the test adds an exports port (a stand-in
 * for the service's PRO-063 routes that reports a job's states through `onProgress`). The dialog is
 * opened with the registry's `document.export` command. The element, not a harness, builds the
 * dialog's export service (`src/export-service.ts`) and passes it to the shell, and the engine core
 * does the block selection. Run with
 * `DOCEDIT_DEMO_PORT=57330 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/ux-101-export-dialog.spec.ts --project=<browser>`.
 */
import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { SPIKE_IDS } from '@docedit/engine/spike-document';
import { openEmbed } from './embed-helpers.ts';

const EDITOR = 'doc-editor[data-test="export"]';

declare global {
  interface Window {
    __exportCalls?: { requests: unknown[]; cancelled: string[] };
  }
}

/**
 * Mounts an element whose backend has an exports port. `hold` keeps the job in `compiling` until
 * the test calls `window.__exportCalls.finish()`, so that the running state can be seen and
 * cancelled.
 */
async function mountWithExports(
  page: Page,
  blocks: { here: string; gone: string },
  hold: boolean,
): Promise<void> {
  await page.evaluate(
    async ({ blocks: ids, hold: keep }) => {
      const e = (
        window as unknown as {
          __embed: { backend(sub: string, role: string): unknown; docId: string };
        }
      ).__embed;
      const backend = e.backend('ada', 'editor') as {
        features: ReadonlySet<string>;
        connect(): Promise<void>;
        exports?: unknown;
      };
      const connect = backend.connect.bind(backend);
      backend.connect = async () => {
        await connect();
        backend.features = new Set([...backend.features, 'exports']);
      };
      const calls = { requests: [] as unknown[], cancelled: [] as string[] };
      (window as unknown as { __exportCalls: unknown }).__exportCalls = calls;
      const job = (state: string) => ({
        id: 'job-ux101-1',
        doc: e.docId,
        target: 'pdf',
        seq: 1,
        state,
        progress: state === 'compiling' ? 40 : state === 'completed' ? 100 : null,
        result:
          state === 'completed'
            ? {
                url: `${location.origin}/exports/sample.pdf`,
                expiresAt: '2099-01-01T00:00:00Z',
                pages: 3,
                layout: null,
                converged: true,
              }
            : null,
        diagnostics:
          state === 'completed'
            ? [
                {
                  severity: 'warning',
                  code: 'overfull',
                  blockId: ids.here,
                  message: 'Line too wide',
                },
                {
                  severity: 'error',
                  code: 'missing',
                  blockId: ids.gone,
                  message: 'Picture missing',
                },
              ]
            : [],
        createdAt: '2026-11-17T10:00:00Z',
        updatedAt: '2026-11-17T10:00:00Z',
      });
      backend.exports = {
        request: async (
          _docId: string,
          body: unknown,
          opts?: { onProgress?: (j: unknown) => void },
        ) => {
          calls.requests.push(body);
          opts?.onProgress?.(job('queued'));
          setTimeout(() => opts?.onProgress?.(job('compiling')), 20);
          const finish = () => opts?.onProgress?.(job('completed'));
          if (keep) (calls as unknown as { finish: () => void }).finish = finish;
          else setTimeout(finish, 80);
          return job('queued');
        },
        get: async () => job('completed'),
        cancel: async (id: string) => {
          calls.cancelled.push(id);
        },
      };
      const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
      el.dataset['test'] = 'export';
      el.setAttribute('doc-id', e.docId);
      const ready = new Promise<void>((resolve, reject) => {
        el.addEventListener('de-ready', () => resolve(), { once: true });
        el.addEventListener(
          'de-error',
          (ev) => reject(new Error(JSON.stringify((ev as CustomEvent).detail))),
          {
            once: true,
          },
        );
      });
      el.backend = backend;
      document.getElementById('mount')!.append(el);
      await ready;
    },
    { blocks, hold },
  );
  await expect(page.locator(`${EDITOR} .de-editing-surface`)).toBeVisible();
}

function openDialog(page: Page): Promise<boolean> {
  return page.evaluate(
    (sel) =>
      (
        document.querySelector(sel) as unknown as {
          exec(name: string): { ok: boolean };
        }
      ).exec('document.export').ok,
    EDITOR,
  );
}

function scope(page: Page): Promise<{ scope: string; blockId: string | null }> {
  return page.evaluate((sel) => {
    const hooks = (globalThis as unknown as { __embed: { internals(el: Element): unknown } })
      .__embed;
    const internals = hooks.internals(document.querySelector(sel)!) as {
      editor: { core: { selectionScope(): { scope: string; blockId: string | null } } };
    };
    return internals.editor.core.selectionScope();
  }, EDITOR);
}

test.describe('the export dialog in the element (UX-101)', () => {
  test('offers the PDF and the LaTeX bundle first, sends the options of EXP-005, and shows the finished job', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountWithExports(page, { here: SPIKE_IDS.last, gone: 'b-not-there' }, false);
    expect(await openDialog(page)).toBe(true);

    const dialog = page.locator(`${EDITOR} dialog`);
    await expect(dialog).toBeVisible();
    const targets = dialog.getByRole('radio');
    await expect(targets.nth(0)).toHaveAccessibleName('PDF');
    await expect(targets.nth(1)).toHaveAccessibleName('LaTeX bundle');

    await dialog.getByLabel('PDF standard').selectOption('ua-2');
    await dialog.getByLabel('Language for dates and text').fill('en-GB');
    await dialog.getByLabel('Time zone').fill('Europe/London');
    await dialog.getByRole('button', { name: 'Export', exact: true }).click();

    await expect(dialog.locator('[data-status="export"]')).toHaveText('Finished');
    await expect(dialog.locator('[data-export="pages"]')).toContainText('3');
    await expect(dialog.locator('[data-export="converged"]')).toBeVisible();
    const sent = await page.evaluate(() => window.__exportCalls!.requests);
    expect(sent).toEqual([
      {
        target: 'pdf',
        options: {
          profile: 'preview',
          tagging: 'on',
          fields: 'flatten',
          pdfStandard: 'ua-2',
          locale: 'en-GB',
          timeZone: 'Europe/London',
        },
      },
    ]);
  });

  test('leaves the options without a value out of the request', async ({ page }) => {
    await openEmbed(page);
    await mountWithExports(page, { here: SPIKE_IDS.last, gone: 'b-not-there' }, false);
    await openDialog(page);
    const dialog = page.locator(`${EDITOR} dialog`);
    await dialog.getByRole('button', { name: 'Export', exact: true }).click();
    await expect(dialog.locator('[data-status="export"]')).toHaveText('Finished');
    const sent = (await page.evaluate(() => window.__exportCalls!.requests)) as Array<{
      options: Record<string, unknown>;
    }>;
    expect(Object.keys(sent[0]!.options).sort()).toEqual(['fields', 'profile', 'tagging']);
  });

  test('a diagnostic selects the block it names, with its severity in words; a missing block is said so', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountWithExports(page, { here: SPIKE_IDS.last, gone: 'b-not-there' }, false);
    await openDialog(page);
    const dialog = page.locator(`${EDITOR} dialog`);
    await dialog.getByRole('button', { name: 'Export', exact: true }).click();
    await expect(dialog.locator('[data-status="export"]')).toHaveText('Finished');

    const items = dialog.locator('.de-list li');
    await expect(items).toHaveCount(2);
    await expect(items.nth(0).locator('.de-severity')).toHaveText('Warning');
    await expect(items.nth(1).locator('.de-severity')).toHaveText('Error');

    // A block that is not in the document: the dialog stays open and says so.
    await items.nth(1).getByRole('button').click();
    await expect(dialog.getByText('That part is no longer in the document.')).toBeVisible();

    // The block that is: the dialog closes and the core's selection is in it.
    await items.nth(0).getByRole('button').click();
    await expect(dialog).toBeHidden();
    await expect.poll(async () => (await scope(page)).blockId).toBe(SPIKE_IDS.last);
    expect((await scope(page)).scope).toBe('body');
  });

  test('a running job can be cancelled', async ({ page }) => {
    await openEmbed(page);
    await mountWithExports(page, { here: SPIKE_IDS.last, gone: 'b-not-there' }, true);
    await openDialog(page);
    const dialog = page.locator(`${EDITOR} dialog`);
    await dialog.getByRole('button', { name: 'Export', exact: true }).click();
    await expect(dialog.locator('[data-status="export"]')).toHaveText('Typesetting');
    await dialog.getByRole('button', { name: 'Cancel the export' }).click();
    await expect
      .poll(() => page.evaluate(() => window.__exportCalls!.cancelled))
      .toEqual(['job-ux101-1']);
  });
});
