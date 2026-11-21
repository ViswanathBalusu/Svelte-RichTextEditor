/**
 * The PDF preview pane in the production element (EXP-001 criterion 1, the element's half; lane w2,
 * 2026-11-20). The real element runs with its demo backend, to which the test adds an exports port:
 * a stand-in for the service's routes (PRO-063) that reports a job's states through `onProgress`
 * and whose finished job names a PDF the demo server serves as a signed export URL does (CORS,
 * another origin than the viewer's). The viewer is the real one: PDF.js in a sandboxed frame of
 * another origin (FE-071), put into the pane by the element's `pdf` service.
 *
 * The run against a real document service and a LuaLaTeX worker is
 * apps/reference-host/e2e/w2-exp-001-pdf-export.spec.ts.
 *
 * Run with
 * `DOCEDIT_DEMO_PORT=57341 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/exp-001-pdf-pane.spec.ts --project=<browser>`.
 * On the development machine a local filter empties PDF responses to Firefox and Edge (spike S2
 * §2), so the tests that draw a PDF from its URL run in Chromium and WebKit; the others run in all.
 */
import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { FILTERED_BROWSERS, openEmbed } from './embed-helpers.ts';

const PORT = Number(process.env['DOCEDIT_DEMO_PORT'] ?? 4791);
const VIEWER = `http://localhost:${PORT}/lib/viewer/pdf-viewer.html`;
const EDITOR = 'doc-editor[data-test="pdf-pane"]';

interface Calls {
  requests: Array<{ target: string; options: Record<string, unknown> }>;
  cancelled: string[];
  finish?: (id: string) => void;
}

declare global {
  interface Window {
    __pdfPaneCalls?: Calls;
  }
}

/**
 * Mounts an element whose backend has an exports port. Each request is a job of its own
 * (`job-1`, `job-2`, ...). With `hold`, a job stays in `compiling` until the test calls
 * `window.__pdfPaneCalls.finish(id)`. `file` is the export the finished job names.
 */
async function mountWithExports(
  page: Page,
  opts: { hold?: boolean; file?: string } = {},
): Promise<void> {
  await page.evaluate(
    async ({ hold, file, viewer, port }) => {
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
      const calls: {
        requests: unknown[];
        cancelled: string[];
        finish?: (id: string) => void;
      } = { requests: [], cancelled: [] };
      (window as unknown as { __pdfPaneCalls: unknown }).__pdfPaneCalls = calls;
      const reports = new Map<string, (j: unknown) => void>();
      const job = (id: string, state: string) => ({
        id,
        doc: e.docId,
        target: 'pdf',
        seq: 1,
        state,
        progress: state === 'compiling' ? 40 : state === 'completed' ? 100 : null,
        result:
          state === 'completed'
            ? {
                // A signed URL of another origin than the viewer's, as an object store's is.
                url: `http://127.0.0.1:${port}/exports/${file}&sig=test-signature`,
                expiresAt: '2099-01-01T00:00:00Z',
                pages: 3,
                layout: null,
                converged: false,
              }
            : null,
        diagnostics: [],
        createdAt: '2026-11-20T10:00:00Z',
        updatedAt: '2026-11-20T10:00:00Z',
      });
      calls.finish = (id: string) => reports.get(id)?.(job(id, 'completed'));
      let n = 0;
      backend.exports = {
        request: async (
          _docId: string,
          body: unknown,
          o?: { onProgress?: (j: unknown) => void },
        ) => {
          calls.requests.push(body);
          const id = `job-${++n}`;
          if (o?.onProgress) reports.set(id, o.onProgress);
          o?.onProgress?.(job(id, 'queued'));
          setTimeout(() => o?.onProgress?.(job(id, 'compiling')), 20);
          if (!hold) setTimeout(() => calls.finish!(id), 80);
          return job(id, 'queued');
        },
        get: async (id: string) => job(id, 'completed'),
        cancel: async (id: string) => {
          calls.cancelled.push(id);
        },
      };
      const el = document.createElement('doc-editor') as HTMLElement & Record<string, unknown>;
      el.dataset['test'] = 'pdf-pane';
      el['config'] = { pdfViewerUrl: viewer };
      el.setAttribute('doc-id', e.docId);
      const ready = new Promise<void>((resolve, reject) => {
        el.addEventListener('de-ready', () => resolve(), { once: true });
        el.addEventListener(
          'de-error',
          (ev) => reject(new Error(JSON.stringify((ev as CustomEvent).detail))),
          { once: true },
        );
      });
      el['backend'] = backend;
      document.getElementById('mount')!.append(el);
      await ready;
    },
    {
      hold: opts.hold === true,
      file: opts.file ?? 'pages.pdf?pages=3',
      viewer: VIEWER,
      port: PORT,
    },
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

/** Opens the pane as a command of the shell would (the element's test hook). */
function openPane(page: Page): Promise<boolean> {
  return page.evaluate((sel) => {
    const hooks = (
      globalThis as unknown as {
        __embed: {
          internals(el: Element): { editor: { openPane(id: string): Promise<boolean> } };
        };
      }
    ).__embed;
    return hooks.internals(document.querySelector(sel)!).editor.openPane('pdf');
  }, EDITOR);
}

const calls = (page: Page): Promise<Calls> =>
  page.evaluate(() => {
    const c = window.__pdfPaneCalls!;
    return { requests: c.requests, cancelled: c.cancelled };
  });

function viewerFrame(page: Page) {
  return page.frames().find((f) => f.url().startsWith(VIEWER));
}

test.describe('EXP-001 the PDF preview pane in the element', () => {
  test('a PDF exported from the dialog opens in the pane, in the sandboxed viewer of another origin', async ({
    page,
  }, info) => {
    test.skip(
      FILTERED_BROWSERS.has(info.project.name),
      'PDF responses are filtered for this browser on this machine (spike S2 §2)',
    );
    await openEmbed(page);
    await mountWithExports(page);
    expect(await openDialog(page)).toBe(true);
    const dialog = page.locator(`${EDITOR} dialog`);
    await dialog.getByRole('button', { name: 'Export', exact: true }).click();
    await expect(dialog.locator('[data-status="export"]')).toHaveText('Finished');
    await dialog.getByRole('button', { name: 'Show in the PDF preview' }).click();
    await expect(dialog).toBeHidden();

    const pane = page.locator(`${EDITOR} [data-pane="pdf"]`);
    await expect(pane).toBeVisible();
    await expect(pane.getByRole('heading', { name: 'PDF preview' })).toBeVisible();
    const frame = pane.locator('iframe.de-pdf-frame');
    await expect(frame).toBeVisible();
    await expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin');
    // The page count is the viewer's own reading of the file, not the job's figure (3 in both).
    await expect(pane.locator('[data-pdf="pages"]')).toHaveText('3 pages');
    await expect(pane.locator('[data-status="pdf"]')).toHaveText('Finished');
    // The job said its page references did not converge: the pane says so in words (09 §8).
    await expect(pane.locator('[data-pdf="stale"]')).toContainText(
      'Page references may still change',
    );

    // The frame is of another origin than the page, and it drew the first page.
    const inner = viewerFrame(page)!;
    expect(new URL(inner.url()).origin).not.toBe(new URL(page.url()).origin);
    await expect
      .poll(() =>
        inner.evaluate(() => document.querySelector('canvas.page')?.getAttribute('aria-label')),
      )
      .toBe('Page 1 of 3');
    // The pane showed the dialog's job: no second export was asked for.
    expect((await calls(page)).requests).toHaveLength(1);

    // Closing the pane removes the frame, and a finished export is not cancelled.
    await pane.getByRole('button', { name: 'Close PDF preview' }).click();
    await expect(pane).toBeHidden();
    await expect(page.locator(`${EDITOR} iframe.de-pdf-frame`)).toHaveCount(0);
    expect((await calls(page)).cancelled).toEqual([]);
  });

  test('opened with nothing to show, the pane asks for a quick preview and shows it', async ({
    page,
  }, info) => {
    test.skip(
      FILTERED_BROWSERS.has(info.project.name),
      'PDF responses are filtered for this browser on this machine (spike S2 §2)',
    );
    await openEmbed(page);
    await mountWithExports(page, { file: 'sample.pdf?v=1' });
    expect(await openPane(page)).toBe(true);
    const pane = page.locator(`${EDITOR} [data-pane="pdf"]`);
    await expect(pane.locator('iframe.de-pdf-frame')).toBeVisible();
    await expect(pane.locator('[data-pdf="pages"]')).toHaveText('1 page');
    expect((await calls(page)).requests).toEqual([
      { target: 'pdf', options: { profile: 'preview' } },
    ]);

    // "Make a new preview" asks again, and the pane then shows the newer job.
    await pane.getByRole('button', { name: 'Make a new preview' }).click();
    await expect.poll(async () => (await calls(page)).requests.length).toBe(2);
    await expect(pane.locator('section.de-pdf-pane')).toHaveAttribute('data-state', 'completed');
    await expect(pane.locator('iframe.de-pdf-frame')).toHaveCount(1);
    await expect(pane.locator('[data-pdf="pages"]')).toHaveText('1 page');
  });

  test('closing the pane cancels a preview of its own that has not finished', async ({ page }) => {
    await openEmbed(page);
    await mountWithExports(page, { hold: true });
    expect(await openPane(page)).toBe(true);
    const pane = page.locator(`${EDITOR} [data-pane="pdf"]`);
    await expect(pane.locator('[data-status="pdf"]')).toHaveText('Typesetting');
    await expect(pane.getByRole('progressbar', { name: 'Export progress' })).toBeVisible();
    await expect(pane.locator('iframe.de-pdf-frame')).toHaveCount(0);
    await pane.getByRole('button', { name: 'Close PDF preview' }).click();
    await expect(pane).toBeHidden();
    await expect.poll(async () => (await calls(page)).cancelled).toEqual(['job-1']);
  });

  test('a running preview can be cancelled from the pane', async ({ page }) => {
    await openEmbed(page);
    await mountWithExports(page, { hold: true });
    expect(await openPane(page)).toBe(true);
    const pane = page.locator(`${EDITOR} [data-pane="pdf"]`);
    await expect(pane.locator('[data-status="pdf"]')).toHaveText('Typesetting');
    await pane.getByRole('button', { name: 'Cancel the export' }).click();
    await expect.poll(async () => (await calls(page)).cancelled).toEqual(['job-1']);
  });

  test('a PDF the viewer cannot load is said so, and the pane offers a new preview', async ({
    page,
  }) => {
    await openEmbed(page);
    // The server has no export of this name, so the viewer's fetch fails in every browser.
    await mountWithExports(page, { file: 'missing.pdf?v=1' });
    expect(await openPane(page)).toBe(true);
    const pane = page.locator(`${EDITOR} [data-pane="pdf"]`);
    await expect(pane.locator('[data-pdf="view-failed"]')).toHaveText(
      'The PDF could not be shown. Make a new preview to try again.',
    );
    await expect(pane.locator('[data-pdf="pages"]')).toHaveCount(0);
    await expect(pane.locator('iframe.de-pdf-frame')).toHaveCount(0);
    await expect(pane.getByRole('button', { name: 'Make a new preview' })).toBeEnabled();
  });

  test('the pane is not offered without the exports feature', async ({ page }) => {
    await openEmbed(page);
    await page.evaluate(async () => {
      const e = (
        window as unknown as { __embed: { backend(s: string, r: string): unknown; docId: string } }
      ).__embed;
      const el = document.createElement('doc-editor') as HTMLElement & Record<string, unknown>;
      el.dataset['test'] = 'pdf-pane';
      el['backend'] = e.backend('ada', 'editor');
      el.setAttribute('doc-id', e.docId);
      const ready = new Promise((r) => el.addEventListener('de-ready', r, { once: true }));
      document.getElementById('mount')!.append(el);
      await ready;
    });
    expect(await openPane(page)).toBe(false);
    await expect(page.locator(`${EDITOR} [data-pane="pdf"]`)).toHaveCount(0);
  });
});
