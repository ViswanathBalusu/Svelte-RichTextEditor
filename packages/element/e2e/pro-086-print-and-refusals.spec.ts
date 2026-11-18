/**
 * PRO-086 criteria 3 and 4 (lane w5), on the production element in a browser.
 *
 * Criterion 3: `print()` asks the backend's exports port for a typeset PDF (`target: 'pdf'`), polls
 * the job, and prints the file at the job's URL in a hidden frame of the element's shadow root. It
 * prints nothing else: the frame loads the job's URL and nothing of the page, the host page's
 * `window.print` is not called, and the frame is removed after `afterprint`. The stand-in port
 * completes at once with a blob URL of an HTML page that stands for the PDF (a headless browser has
 * no PDF viewer and shows no print dialogue, so what the real print path sends cannot be seen; see
 * FE-073's Notes). The frame's window is the same window that receives `print()`, so the test
 * replaces that window's `print` right after the frame is added and counts the call.
 *
 * Criterion 4: with `no-export` in the access, `requestExport` rejects with `forbidden` and the
 * reason `no-export`; with `no-print`, `print()` resolves `{ status: 'refused', reason: 'no-print' }`.
 * In both cases the exports port is not called.
 *
 * The backend is the embed page's in-memory mock with a stand-in `exports` port, as in
 * pro-086-export-events.spec.ts. Run from the repository root with
 * `DOCEDIT_DEMO_PORT=57086 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/pro-086-print-and-refusals.spec.ts`.
 */
import { expect, test, type Page } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';

interface Probe {
  requests: Array<{ docId: string; body: unknown }>;
  printed: string[];
}

/** Mounts the element on a backend whose stand-in exports port completes every job at once. */
async function mount(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const e = (window as unknown as { __embed: { backend(sub: string): unknown; docId: string } })
      .__embed;
    const backend = e.backend('ada') as {
      features: ReadonlySet<string>;
      connect(): Promise<void>;
      exports?: unknown;
    };
    const connect = backend.connect.bind(backend);
    backend.connect = async () => {
      await connect();
      backend.features = new Set([...backend.features, 'exports']);
    };
    const probe: Probe = { requests: [], printed: [] };
    const page = new Blob(['<!doctype html><title>typeset pdf</title><p>stands for the PDF</p>'], {
      type: 'text/html',
    });
    const url = URL.createObjectURL(page);
    backend.exports = {
      request: async (docId: string, body: unknown) => {
        probe.requests.push({ docId, body });
        return { id: 'job-pro-086', docId, state: 'queued', progress: null, target: 'pdf' };
      },
      get: async () => ({
        id: 'job-pro-086',
        state: 'completed',
        progress: 1,
        result: { url },
      }),
      cancel: async () => {},
    };
    (window as unknown as { __probe: Probe }).__probe = probe;
    window.print = () => {
      probe.printed.push('host window.print');
    };
    const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
    el.dataset['test'] = 'pro-086';
    const ready = new Promise<void>((resolve) =>
      el.addEventListener('de-ready', () => resolve(), { once: true }),
    );
    el.backend = backend;
    el.setAttribute('doc-id', e.docId);
    document.getElementById('mount')!.append(el);
    await ready;
  });
}

/** Sets the restrictions on the element's core as a new access revision, as `perm.changed` does. */
async function restrict(page: Page, restriction: string): Promise<void> {
  await page.evaluate(async (value) => {
    const el = document.querySelector('doc-editor[data-test="pro-086"]') as HTMLElement;
    const changed = new Promise<void>((resolve) =>
      el.addEventListener('de-permission-change', (event) => {
        const detail = (event as CustomEvent<{ restrictions?: string[] }>).detail;
        if (detail?.restrictions?.includes(value)) resolve();
      }),
    );
    const embed = (
      window as unknown as {
        __embed: {
          internals(el: Element): {
            editor: {
              core: {
                permissions: { get(): { rev: number } & Record<string, unknown> };
                setAccess(a: unknown): void;
              };
            } | null;
          };
        };
      }
    ).__embed;
    const core = embed.internals(el).editor!.core;
    const current = core.permissions.get();
    core.setAccess({ ...current, rev: current.rev + 1, restrictions: [value] });
    await changed;
  }, restriction);
}

test('PRO-086 criterion 3: print() prints the PDF of the export job, in a frame, and nothing of the page', async ({
  page,
}) => {
  await openEmbed(page);
  await mount(page);
  const facts = await page.evaluate(async () => {
    const el = document.querySelector('doc-editor[data-test="pro-086"]') as HTMLElement & {
      print(): Promise<unknown>;
    };
    const probe = (window as unknown as { __probe: Probe }).__probe;
    const frames: Array<{ src: string; printedInFrame: number; sameWindowAsHost: boolean }> = [];
    let removed = 0;
    new MutationObserver((records) => {
      for (const r of records) {
        for (const n of Array.from(r.addedNodes)) {
          if (!(n instanceof HTMLIFrameElement)) continue;
          const win = n.contentWindow as (Window & { print: () => void }) | null;
          const record = { src: n.src, printedInFrame: 0, sameWindowAsHost: win === window };
          frames.push(record);
          if (win)
            win.print = () => {
              record.printedInFrame += 1;
              win.dispatchEvent(new Event('afterprint'));
            };
        }
        removed += r.removedNodes.length;
      }
    }).observe(el.shadowRoot!, { childList: true, subtree: true });
    const outcome = await el.print();
    await new Promise((r) => setTimeout(r, 200));
    return {
      outcome,
      frames,
      removed,
      requests: probe.requests,
      hostPrinted: probe.printed,
      framesLeft: el.shadowRoot!.querySelectorAll('iframe').length,
      framesInHostDocument: document.querySelectorAll('iframe').length,
    };
  });

  expect(facts.requests).toHaveLength(1);
  expect(facts.requests[0]?.body).toMatchObject({ target: 'pdf' });
  expect(facts.outcome).toEqual({ status: 'printed' });
  expect(facts.frames).toHaveLength(1);
  expect(facts.frames[0]?.src).toMatch(/^blob:/);
  expect(facts.frames[0]?.sameWindowAsHost).toBe(false);
  expect(facts.frames[0]?.printedInFrame).toBe(1);
  expect(facts.hostPrinted).toEqual([]);
  expect(facts.framesLeft).toBe(0);
  expect(facts.framesInHostDocument).toBe(0);
});

test('PRO-086 criterion 4: no-export refuses requestExport and no-print refuses print(), each with its reason', async ({
  page,
}) => {
  await openEmbed(page);
  await mount(page);

  await restrict(page, 'no-export');
  const exportRefusal = await page.evaluate(async () => {
    const el = document.querySelector('doc-editor[data-test="pro-086"]') as HTMLElement & {
      requestExport(options: unknown): Promise<unknown>;
    };
    try {
      await el.requestExport({ target: 'pdf' });
      return { rejected: false };
    } catch (e) {
      const error = e as { code?: string; details?: unknown; message?: string };
      return { rejected: true, code: error.code, details: error.details, message: error.message };
    }
  });
  expect(exportRefusal).toMatchObject({
    rejected: true,
    code: 'forbidden',
    details: { reason: 'no-export' },
  });

  await restrict(page, 'no-print');
  const printRefusal = await page.evaluate(async () => {
    const el = document.querySelector('doc-editor[data-test="pro-086"]') as HTMLElement & {
      print(): Promise<unknown>;
    };
    return el.print();
  });
  expect(printRefusal).toEqual({ status: 'refused', reason: 'no-print' });

  const probe = await page.evaluate(() => (window as unknown as { __probe: Probe }).__probe);
  expect(probe.requests).toEqual([]);
  expect(probe.printed).toEqual([]);
});
