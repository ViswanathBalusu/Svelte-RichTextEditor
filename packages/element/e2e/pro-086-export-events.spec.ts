/**
 * PRO-086 criterion 2 (lane U-FRW-073-089, fixing the round 2 review of lane U-PRO-086-102): the
 * element raises `de-export-progress`, `de-export-completed` and `de-export-failed` on the host
 * while an export job reports, with the job's identifiers and state only, and raises nothing for a
 * job that a replaced session started.
 *
 * The backend is the embed page's in-memory mock (demo/embed-page.ts), given an `exports` port and
 * the `exports` feature by the test, because the mock has neither. The stand-in port keeps the
 * `onProgress` callback that `requestExport` passes to it (src/export.ts), and the test drives it.
 * Every job the stand-in reports carries fields beyond the three of the detail (`docId`, `target`,
 * `result`), so the check that the detail holds `jobId`, `state` and `progress` only is meaningful.
 * Events are read from the embed page's recorder, a listener on `document`, so a recorded event has
 * left the shadow root. Chromium, Edge, Firefox and WebKit (playwright.config.ts projects).
 */
import { expect, test, type Page } from '@playwright/test';
import { events, openEmbed, type Recorded } from './embed-helpers.ts';

const EXPORT_EVENTS = ['de-export-progress', 'de-export-completed', 'de-export-failed'];

interface Harness {
  /** Mounts the element with the instrumented backend and waits for `de-ready`. */
  mount(): Promise<void>;
  /** Calls `el.requestExport` and resolves its result. */
  request(): Promise<{ jobId: string }>;
  /** Reports `state` for the job `jobId` through the `onProgress` the element passed. */
  report(jobId: string, state: string, progress: number | null): void;
  /** Points the element at another document and waits for the new session's `de-ready`. */
  replace(): Promise<void>;
  /** The `docId` each request reached the port with. */
  requests: string[];
}

/** Installs `window.__pro086` in the page: the instrumented backend and the element's handle. */
async function install(page: Page): Promise<void> {
  await page.evaluate(() => {
    interface Job {
      id: string;
      docId: string;
      state: string;
      progress: number | null;
      target: string;
      result: { url: string } | null;
    }
    type OnProgress = (job: Job) => void;
    const e = (
      window as unknown as {
        __embed: { backend(sub: string): unknown; docId: string; secondDocId: string };
      }
    ).__embed;
    const backend = e.backend('ada') as {
      features: ReadonlySet<string>;
      connect(): Promise<void>;
      exports?: unknown;
    };
    // The mock sets its features on connect; the wrapper adds `exports` after each connect, so
    // `hasPort(backend, 'exports')` holds for every session on this backend (src/export.ts).
    const connect = backend.connect.bind(backend);
    backend.connect = async () => {
      await connect();
      backend.features = new Set([...backend.features, 'exports']);
    };
    const callbacks = new Map<string, { docId: string; onProgress: OnProgress }>();
    const requests: string[] = [];
    let next = 0;
    const job = (id: string, docId: string, state: string, progress: number | null): Job => ({
      id,
      docId,
      state,
      progress,
      target: 'pdf',
      result: state === 'completed' ? { url: 'https://assets.invalid/export.pdf' } : null,
    });
    backend.exports = {
      request: async (
        docId: string,
        _body: unknown,
        opts?: { onProgress?: OnProgress },
      ): Promise<Job> => {
        requests.push(docId);
        next += 1;
        const id = `job-pro086-${next}`;
        if (opts?.onProgress) callbacks.set(id, { docId, onProgress: opts.onProgress });
        return job(id, docId, 'queued', null);
      },
      get: async () => {
        throw new Error('not used by this test');
      },
      cancel: async () => {},
    };
    const el = document.createElement('doc-editor') as HTMLElement & {
      backend: unknown;
      requestExport(options: { target: string }): Promise<{ jobId: string }>;
    };
    el.dataset['test'] = 'pro086';
    const ready = (docId: string) =>
      new Promise<void>((resolve) => {
        const on = (ev: Event) => {
          if ((ev as CustomEvent<{ docId: string }>).detail.docId !== docId) return;
          el.removeEventListener('de-ready', on);
          resolve();
        };
        el.addEventListener('de-ready', on);
      });
    const harness: Harness = {
      requests,
      mount: async () => {
        el.backend = backend;
        el.setAttribute('doc-id', e.docId);
        const done = ready(e.docId);
        document.getElementById('mount')!.append(el);
        await done;
      },
      request: () => el.requestExport({ target: 'pdf' }),
      report: (jobId, state, progress) => {
        const entry = callbacks.get(jobId);
        if (!entry) throw new Error(`no onProgress for ${jobId}`);
        entry.onProgress(job(jobId, entry.docId, state, progress));
      },
      replace: async () => {
        const done = ready(e.secondDocId);
        el.setAttribute('doc-id', e.secondDocId);
        await done;
      },
    };
    (window as unknown as { __pro086: Harness }).__pro086 = harness;
  });
}

/**
 * Runs `fn` with the page's harness. The function's source is sent as an expression, which
 * Playwright evaluates outside the page's script policy (the demo server sets one; demo/serve.ts),
 * so no `eval` or `new Function` runs in the page.
 */
function call<T>(page: Page, fn: (h: Harness) => T | Promise<T>): Promise<T> {
  return page.evaluate(`(${fn.toString()})(window.__pro086)`) as Promise<T>;
}

async function exportEvents(page: Page): Promise<Recorded[]> {
  const all = await events(page);
  return all.filter((r) => EXPORT_EVENTS.includes(r.name));
}

/** Lets any event a report would queue reach the document before counting. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise((r) => setTimeout(r, 100)));
}

test.beforeEach(async ({ page }) => {
  await openEmbed(page);
  await install(page);
  await call(page, (h) => h.mount());
});

test('PRO-086: a job that progresses and completes raises the three events on the host', async ({
  page,
}) => {
  const { jobId } = await call(page, (h) => h.request());
  expect(jobId).toBe('job-pro086-1');
  expect(await call(page, (h) => h.requests)).toHaveLength(1);

  await call(page, (h) => {
    h.report('job-pro086-1', 'queued', null);
    h.report('job-pro086-1', 'compiling', 0.5);
    h.report('job-pro086-1', 'completed', 1);
  });
  await settle(page);

  const seen = await exportEvents(page);
  expect(seen.map((r) => r.name)).toEqual([
    'de-export-progress',
    'de-export-progress',
    'de-export-completed',
  ]);
  for (const r of seen) {
    // Raised on the element, and it reached the listener on `document`: bubbling and composed.
    expect(r.target).toBe('doc-editor');
    expect(r.element).toBe('pro086');
    expect(r.bubbles).toBe(true);
    expect(r.composed).toBe(true);
    // Identifiers and job state only: none of the job's other fields (`docId`, `target`, `result`).
    expect(Object.keys(r.detail as object).sort()).toEqual(['jobId', 'progress', 'state']);
  }
  expect(seen.map((r) => r.detail)).toEqual([
    { jobId: 'job-pro086-1', state: 'queued', progress: null },
    { jobId: 'job-pro086-1', state: 'compiling', progress: 0.5 },
    { jobId: 'job-pro086-1', state: 'completed', progress: 1 },
  ]);
});

test('PRO-086: a job that fails raises de-export-failed on the host', async ({ page }) => {
  const { jobId } = await call(page, (h) => h.request());
  await call(page, (h) => {
    h.report('job-pro086-1', 'converting', 0.2);
    h.report('job-pro086-1', 'failed', null);
  });
  await settle(page);

  const seen = await exportEvents(page);
  expect(seen.map((r) => r.name)).toEqual(['de-export-progress', 'de-export-failed']);
  const failed = seen[1]!;
  expect(failed.bubbles).toBe(true);
  expect(failed.composed).toBe(true);
  expect(failed.detail).toEqual({ jobId, state: 'failed', progress: null });
});

test('PRO-086: a job started by a replaced session raises nothing', async ({ page }) => {
  await call(page, (h) => h.request());
  await call(page, (h) => h.report('job-pro086-1', 'queued', null));
  await settle(page);
  expect((await exportEvents(page)).map((r) => r.name)).toEqual(['de-export-progress']);

  // Another document replaces the session that started job 1.
  await call(page, (h) => h.replace());
  await call(page, (h) => {
    h.report('job-pro086-1', 'compiling', 0.5);
    h.report('job-pro086-1', 'completed', 1);
  });
  await settle(page);
  expect((await exportEvents(page)).map((r) => r.name)).toEqual(['de-export-progress']);

  // A job of the current session still reports, so the silence above comes from the guard.
  const { jobId } = await call(page, (h) => h.request());
  expect(jobId).toBe('job-pro086-2');
  await call(page, (h) => h.report('job-pro086-2', 'completed', 1));
  await settle(page);
  const seen = await exportEvents(page);
  expect(seen.map((r) => r.name)).toEqual(['de-export-progress', 'de-export-completed']);
  expect(seen[1]!.detail).toEqual({ jobId: 'job-pro086-2', state: 'completed', progress: 1 });
  expect(await call(page, (h) => h.requests)).toEqual(
    await page.evaluate(() => {
      const e = (window as unknown as { __embed: { docId: string; secondDocId: string } }).__embed;
      return [e.docId, e.secondDocId];
    }),
  );
});
