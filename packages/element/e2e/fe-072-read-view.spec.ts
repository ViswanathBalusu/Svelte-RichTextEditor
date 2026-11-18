/**
 * FE-072 criteria 1, 2, 3 and 5 (lane U-FE-065-080) and FE-065 criterion 2 for `view="read"`: the
 * element shows the pages of the typeset PDF read-only, with no editing surface, shows the export's
 * progress while it runs, lists the diagnostics of the job with their block identifiers (also when
 * the export fails), and labels the view as the typeset result. Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-072-read-view.spec.ts`
 * in Chromium, Firefox and WebKit.
 *
 * The embed page's mock backend has no export port, so the test gives its backend one (as
 * e2e/pro-086-export-events.spec.ts does): `request` starts a job, and `get` reports `compiling` once
 * and then the final state of the test (`completed` with the demo's sample PDF at /exports/sample.pdf,
 * or `failed`), each with one diagnostic that names a block. The read view's poll waits one second
 * between reports (read-view.ts), so the progress text is seen.
 *
 * Not covered here: moving the editor to a diagnostic's block (criterion 4, in
 * e2e/fe-072-open-in-editor.spec.ts) and a change of `view` while the element is open (FE-065
 * criterion 3, in e2e/fe-065-view-switch.spec.ts).
 */
import { expect, test, type Page } from '@playwright/test';
import { FILTERED_BROWSERS, openEmbed } from './embed-helpers.ts';

interface ReadViewReport {
  editingSurfaces: number;
  readViews: number;
  label: string | null;
  statuses: string[];
  diagnostics: Array<{ text: string; blockId: string | null }>;
  frames: number;
  /** The status text when the wait ended: '' on success, the failure sentence otherwise. */
  finalStatus: string;
}

async function mountReadView(page: Page, final: 'completed' | 'failed'): Promise<ReadViewReport> {
  return page.evaluate(async (finalState: 'completed' | 'failed') => {
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
    let polls = 0;
    const job = (state: string) => ({
      id: 'job-fe072-1',
      docId: e.docId,
      state,
      progress: state === 'compiling' ? 0.5 : null,
      target: 'pdf',
      result:
        state === 'completed' ? { url: `${location.origin}/exports/sample.pdf`, pages: 1 } : null,
      error: state === 'failed' ? { code: 'internal', message: 'the worker stopped' } : undefined,
      diagnostics:
        state === 'completed' || state === 'failed'
          ? [{ severity: 'warning', code: 'FE072', message: 'a line is too long', blockId: 'b-7' }]
          : [],
    });
    backend.exports = {
      request: async () => job('queued'),
      get: async () => {
        polls += 1;
        return job(polls === 1 ? 'compiling' : finalState);
      },
      cancel: async () => {},
    };

    const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
    el.dataset['test'] = `fe-072-${finalState}`;
    el.setAttribute('view', 'read');
    el.setAttribute('doc-id', e.docId);
    // The viewer's page as the PDF tests set it (pdf-viewer.spec.ts); the default is not used here.
    (el as unknown as { config: unknown }).config = {
      pdfViewerUrl: `${location.origin}/lib/viewer/pdf-viewer.html`,
    };
    el.backend = backend;
    document.getElementById('mount')!.append(el);

    const root = el.shadowRoot!;
    const deadline = Date.now() + 20_000;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    while (!root.querySelector('.de-read-view')) {
      if (Date.now() > deadline) throw new Error('no read view');
      await sleep(50);
    }
    const section = root.querySelector('.de-read-view')!;
    const status = root.querySelector('.de-read-status')!;
    const statuses: string[] = [];
    const observer = new MutationObserver(() => statuses.push(status.textContent ?? ''));
    observer.observe(section, { childList: true, characterData: true, subtree: true });
    // Wait until the export has ended: a success clears the status once the first page is drawn,
    // a failure puts its sentence in the status.
    const ended = () =>
      finalState === 'completed'
        ? (status.textContent ?? '') === '' && root.querySelector('.de-read-pages iframe') !== null
        : (status.textContent ?? '').includes('could not be made');
    while (!ended()) {
      if (Date.now() > deadline) throw new Error(`export did not end: "${status.textContent}"`);
      await sleep(100);
    }
    observer.disconnect();
    return {
      editingSurfaces: root.querySelectorAll('.de-editing-surface').length,
      readViews: root.querySelectorAll('.de-read-view').length,
      label: root.querySelector('.de-read-label')?.textContent ?? null,
      statuses: [...new Set(statuses)],
      diagnostics: [...root.querySelectorAll('.de-read-diagnostic')].map((li) => ({
        text: li.textContent ?? '',
        blockId: (li as HTMLElement).dataset['blockId'] ?? null,
      })),
      frames: root.querySelectorAll('.de-read-pages iframe').length,
      finalStatus: status.textContent ?? '',
    };
  }, final);
}

test('view="read" shows the typeset PDF with no editing surface, progress and diagnostics (FE-072)', async ({
  page,
}, info) => {
  // The read view opens the signed URL only; on this machine a local filter refuses PDF responses in
  // Firefox and Edge (spike S2 §2, pdf-viewer.spec.ts), so the success path runs in Chromium and WebKit.
  test.skip(
    FILTERED_BROWSERS.has(info.project.name),
    'PDF responses are filtered for this browser on this machine (spike S2 §2); the signed-URL path runs in Chromium and WebKit',
  );
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openEmbed(page);
  const report = await mountReadView(page, 'completed');
  // WebKit reports one message while the viewer's document loads the PDF (a synchronous request in
  // the viewer's loading code, seen on this machine). It comes from the viewer, not from the read
  // view, and it is the only message allowed here; it is named so that any other error fails.
  const viewerLoadMessage =
    'XMLHttpRequest.responseType cannot be changed for synchronous HTTP(S) requests made from the window context.';
  const unexpected = errors.filter((m) => m !== viewerLoadMessage);

  // Criterion 1: the pages are drawn read-only, with no editing surface (the status clears once the
  // viewer has drawn the first page, read-view.ts).
  expect(report.editingSurfaces).toBe(0);
  expect(report.readViews).toBe(1);
  expect(report.frames).toBe(1);
  expect(report.finalStatus).toBe('');
  // Criterion 2: the progress of the running export was shown before the result.
  expect(
    report.statuses.some(
      (s) => s.includes('Preparing the typeset PDF') && s.includes('compiling, 50%'),
    ),
  ).toBe(true);
  // Criterion 3: the diagnostics are listed, each with the block it points at.
  expect(report.diagnostics).toEqual([
    { text: 'warning: FE072: a line is too long', blockId: 'b-7' },
  ]);
  // Criterion 5: labelled as the typeset result, not as an editing view.
  expect(report.label).toBe('Typeset result, not an editing view');
  expect(unexpected).toEqual([]);
});

test('a failed export lists its diagnostics and shows no pages (FE-072 criterion 3)', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openEmbed(page);
  const report = await mountReadView(page, 'failed');

  expect(report.editingSurfaces).toBe(0);
  expect(report.frames).toBe(0);
  expect(report.finalStatus).toContain('could not be made: the worker stopped');
  expect(report.diagnostics).toEqual([
    { text: 'warning: FE072: a line is too long', blockId: 'b-7' },
  ]);
  expect(errors).toEqual([]);
});
