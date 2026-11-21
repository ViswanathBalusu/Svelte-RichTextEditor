/**
 * The export preflight in the production element (EXP-003 criteria 2 and 3; lane w2, 2026-11-20).
 * The real element runs with the demo's mock service, on a document of its own that holds a picture
 * without alternative text; the test adds an exports port (a stand-in for the service's routes that
 * records each request). The element, not a harness, runs the preflight: its export service calls
 * `preflight()` of `@docedit/export-latex` on the document the editing core holds
 * (`src/export-preflight.ts`, `src/doc-editor.ts`), and the shell's export dialog lists what it
 * finds before any job is created.
 *
 * Run with
 * `DOCEDIT_DEMO_PORT=57342 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/exp-003-preflight-dialog.spec.ts --project=<browser>`.
 */
import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { spikeDocument } from '@docedit/engine/spike-document';
import { openEmbed } from './embed-helpers.ts';

const EDITOR = 'doc-editor[data-test="preflight"]';
const PICTURE = 'pPicture00000001';
const ALT_WARNING = 'an image has no alternative text (09 §13)';

declare global {
  interface Window {
    __preflightCalls?: { requests: unknown[] };
  }
}

/** The spike document, with or without a last paragraph that holds a picture without text. */
function envelope(withPicture: boolean): unknown {
  const doc = spikeDocument() as unknown as {
    doc: { content: Array<{ type: string; content: unknown[] }> };
  };
  if (withPicture)
    doc.doc.content
      .find((c) => c.type === 'body')!
      .content.push({
        type: 'paragraph',
        attrs: { id: PICTURE, style: 'Normal' },
        content: [
          { type: 'text', text: 'A picture: ' },
          {
            type: 'image',
            attrs: { asset: '0190d5a4-7c3e-7d2a-9a1b-00000000000a', width: 600, height: 400 },
          },
        ],
      });
  return doc;
}

/** Mounts an element on a new document of the mock service, with an exports port that records. */
async function mount(page: Page, withPicture: boolean): Promise<void> {
  await page.evaluate(
    async ({ content }) => {
      const e = (
        window as unknown as {
          __embed: {
            service: {
              createDocument(envelope: unknown): string;
              backend(user: { sub: string; name: string }, docs: Record<string, string>): unknown;
            };
          };
        }
      ).__embed;
      const docId = e.service.createDocument(content);
      const backend = e.service.backend({ sub: 'ada', name: 'Ada' }, { [docId]: 'editor' }) as {
        features: ReadonlySet<string>;
        connect(): Promise<void>;
        exports?: unknown;
      };
      const connect = backend.connect.bind(backend);
      backend.connect = async () => {
        await connect();
        backend.features = new Set([...backend.features, 'exports']);
      };
      const calls = { requests: [] as unknown[] };
      (window as unknown as { __preflightCalls: unknown }).__preflightCalls = calls;
      const job = (state: string) => ({
        id: 'job-exp003-1',
        doc: docId,
        target: 'pdf',
        seq: 1,
        state,
        progress: state === 'completed' ? 100 : null,
        result:
          state === 'completed'
            ? {
                url: `${location.origin}/exports/sample.pdf`,
                expiresAt: '2099-01-01T00:00:00Z',
                pages: 1,
                layout: null,
                converged: true,
              }
            : null,
        diagnostics: [],
        createdAt: '2026-11-20T10:00:00Z',
        updatedAt: '2026-11-20T10:00:00Z',
      });
      backend.exports = {
        request: async (
          _docId: string,
          body: unknown,
          opts?: { onProgress?: (j: unknown) => void },
        ) => {
          calls.requests.push(body);
          opts?.onProgress?.(job('queued'));
          setTimeout(() => opts?.onProgress?.(job('completed')), 40);
          return job('queued');
        },
        get: async () => job('completed'),
        cancel: async () => {},
      };
      const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
      el.dataset['test'] = 'preflight';
      el.setAttribute('doc-id', docId);
      const ready = new Promise<void>((resolve, reject) => {
        el.addEventListener('de-ready', () => resolve(), { once: true });
        el.addEventListener(
          'de-error',
          (ev) => reject(new Error(JSON.stringify((ev as CustomEvent).detail))),
          { once: true },
        );
      });
      el.backend = backend;
      document.getElementById('mount')!.append(el);
      await ready;
    },
    { content: envelope(withPicture) },
  );
  await expect(page.locator(`${EDITOR} .de-editing-surface`)).toBeVisible();
}

function openDialog(page: Page): Promise<boolean> {
  return page.evaluate(
    (sel) =>
      (document.querySelector(sel) as unknown as { exec(name: string): { ok: boolean } }).exec(
        'document.export',
      ).ok,
    EDITOR,
  );
}

const requests = (page: Page): Promise<unknown[]> =>
  page.evaluate(() => window.__preflightCalls!.requests);

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

test.describe('EXP-003 the export preflight in the element', () => {
  test('lists the warnings of the shared preflight before any job is created; Do not export creates none', async ({
    page,
  }) => {
    await openEmbed(page);
    await mount(page, true);
    expect(await openDialog(page)).toBe(true);
    const dialog = page.locator(`${EDITOR} dialog[data-dialog="export"]`);
    await dialog.getByRole('button', { name: 'Export', exact: true }).click();

    const found = dialog.locator('[data-export="preflight"]');
    await expect(found).toBeVisible();
    await expect(found.getByRole('heading', { name: 'Check before you export' })).toBeVisible();
    await expect(found).toContainText('Nothing has been exported yet');
    const items = found.locator('.de-list li');
    await expect(items).toHaveCount(1);
    await expect(items.first().locator('.de-severity')).toHaveText('Warning');
    // The words are the converter's own: the same finding, with the same text, as in the job.
    await expect(items.first()).toContainText(ALT_WARNING);
    // Nothing was asked of the service, and no job is shown.
    expect(await requests(page)).toEqual([]);
    await expect(dialog.locator('[data-status="export"]')).toHaveCount(0);

    await found.getByRole('button', { name: 'Do not export' }).click();
    await expect(found).toBeHidden();
    expect(await requests(page)).toEqual([]);
  });

  test('Continue creates the job, with the request unchanged', async ({ page }) => {
    await openEmbed(page);
    await mount(page, true);
    await openDialog(page);
    const dialog = page.locator(`${EDITOR} dialog[data-dialog="export"]`);
    await dialog.getByRole('button', { name: 'Export', exact: true }).click();
    const found = dialog.locator('[data-export="preflight"]');
    await expect(found).toBeVisible();
    expect(await requests(page)).toEqual([]);
    await found.getByRole('button', { name: 'Continue' }).click();
    await expect(dialog.locator('[data-status="export"]')).toHaveText('Finished');
    expect(await requests(page)).toEqual([
      { target: 'pdf', options: { profile: 'preview', tagging: 'on', fields: 'flatten' } },
    ]);
  });

  test('choosing a warning moves the editor to its block and creates no job', async ({ page }) => {
    await openEmbed(page);
    await mount(page, true);
    await openDialog(page);
    const dialog = page.locator(`${EDITOR} dialog[data-dialog="export"]`);
    await dialog.getByRole('button', { name: 'Export', exact: true }).click();
    const found = dialog.locator('[data-export="preflight"]');
    await found.locator('.de-list li').first().getByRole('button').click();
    await expect(dialog).toBeHidden();
    await expect.poll(async () => (await scope(page)).blockId).toBe(PICTURE);
    expect(await requests(page)).toEqual([]);
  });

  test('a document with nothing to warn about is exported at once', async ({ page }) => {
    await openEmbed(page);
    await mount(page, false);
    await openDialog(page);
    const dialog = page.locator(`${EDITOR} dialog[data-dialog="export"]`);
    await dialog.getByRole('button', { name: 'Export', exact: true }).click();
    await expect(dialog.locator('[data-status="export"]')).toHaveText('Finished');
    await expect(dialog.locator('[data-export="preflight"]')).toHaveCount(0);
    expect(await requests(page)).toHaveLength(1);
  });

  test('the preflight sees what was typed since the document was loaded', async ({ page }) => {
    await openEmbed(page);
    await mount(page, true);
    // The picture's paragraph is deleted in the editor, without waiting for any save.
    await page.evaluate(
      ({ sel, id }) => {
        const hooks = (globalThis as unknown as { __embed: { internals(el: Element): unknown } })
          .__embed;
        const internals = hooks.internals(document.querySelector(sel)!) as {
          editor: { core: { selectBlock(id: string): boolean } };
        };
        internals.editor.core.selectBlock(id);
      },
      { sel: EDITOR, id: PICTURE },
    );
    const paragraph = page.locator(`${EDITOR} .de-editing-surface p`).last();
    await paragraph.click();
    await page.keyboard.press('End');
    // Backspace over the picture (one atom) removes it; the text before it stays.
    await page.keyboard.press('Backspace');
    await openDialog(page);
    const dialog = page.locator(`${EDITOR} dialog[data-dialog="export"]`);
    await dialog.getByRole('button', { name: 'Export', exact: true }).click();
    await expect(dialog.locator('[data-status="export"]')).toHaveText('Finished');
    await expect(dialog.locator('[data-export="preflight"]')).toHaveCount(0);
  });
});
