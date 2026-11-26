/**
 * FE-073 criterion 1 (lane w1): `print()` on the element exports the typeset PDF with progress,
 * has the PDF viewer draw its pages and prints them from a separate print-only frame (owner
 * decision 48).
 *
 * The backend is the embed page's in-memory mock with a stand-in `exports` port: the job is
 * `converting` on the first poll and `completed` on the second, with the demo's sample PDF
 * (/exports/sample.pdf). A headless browser shows no print dialogue, so the test records the call:
 * `contentWindow` of each frame is wrapped to catch `print()`. It shows that the print frame is a
 * same-origin `blob:` document without `sandbox`, inside the shadow root, that it holds one canvas
 * with drawn content for the one page, and that `print()` was called on its window once. It does not
 * show what a real print dialogue sends to a printer.
 *
 * Chromium and WebKit only: on this machine a local filter refuses PDF responses in Firefox and Edge
 * (spike S2 §2; see fe-072-read-view.spec.ts).
 *
 * Run from the repository root with
 * `DOCEDIT_DEMO_PORT=57174 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-073-print-success.spec.ts --project=chromium --project=webkit`.
 */
import { expect, test } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';

test('FE-073: the typeset PDF is exported with progress and printed from a print-only frame', async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName === 'firefox',
    'PDF responses are filtered for Firefox on this machine (spike S2 §2)',
  );
  await openEmbed(page);
  const facts = await page.evaluate(async () => {
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
    let polls = 0;
    backend.exports = {
      request: async (docId: string) => ({
        id: 'job-fe-073-ok',
        docId,
        state: 'queued',
        progress: null,
        target: 'pdf',
      }),
      get: async () => {
        polls += 1;
        return polls === 1
          ? { id: 'job-fe-073-ok', state: 'converting', progress: 0.5, result: null }
          : {
              id: 'job-fe-073-ok',
              state: 'completed',
              progress: 1,
              result: { url: `/exports/sample.pdf`, pages: 1 },
            };
      },
      cancel: async () => {},
    };

    // Count print() on the window of each iframe the element creates; the dialogue itself is not shown.
    const printed: {
      src: string;
      sandboxed: boolean;
      inShadowRoot: boolean;
      canvases: number;
      nonBlank: boolean;
    }[] = [];
    const desc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow')!;
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
      configurable: true,
      get(this: HTMLIFrameElement) {
        const real = (desc.get as () => WindowProxy | null).call(this);
        if (!real) return real;
        return new Proxy(real, {
          get: (target, prop) => {
            if (prop === 'print')
              return () => {
                const canvases = [...(this.contentDocument?.querySelectorAll('canvas') ?? [])];
                const nonBlank = canvases.some((c) =>
                  c
                    .getContext('2d')!
                    .getImageData(0, 0, c.width, c.height)
                    .data.some((v) => v !== 0),
                );
                printed.push({
                  canvases: canvases.length,
                  nonBlank,
                  src: this.src,
                  sandboxed: this.hasAttribute('sandbox'),
                  inShadowRoot: this.getRootNode() instanceof ShadowRoot,
                });
              };
            const value = Reflect.get(target, prop) as unknown;
            return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
          },
        });
      },
    });

    const hostPrint: string[] = [];
    window.print = () => {
      hostPrint.push('window.print');
    };
    const el = document.createElement('doc-editor') as HTMLElement & {
      backend: unknown;
      print(): Promise<unknown>;
    };
    const order: string[] = [];
    for (const name of [
      'de-export-progress',
      'de-export-completed',
      'de-export-failed',
      'de-error',
    ])
      el.addEventListener(name, () => order.push(name));
    const ready = new Promise<void>((resolve) =>
      el.addEventListener('de-ready', () => resolve(), { once: true }),
    );
    el.backend = backend;
    el.setAttribute('doc-id', e.docId);
    (el as unknown as { config: unknown }).config = {
      pdfViewerUrl: `/lib/viewer/pdf-viewer.html`,
    };
    document.getElementById('mount')!.append(el);
    await ready;
    order.length = 0;

    const announced: string[] = [];
    const live = el.shadowRoot!.querySelector('.de-live-region')!;
    new MutationObserver(() => announced.push(live.textContent ?? '')).observe(live, {
      childList: true,
      characterData: true,
      subtree: true,
    });

    const outcome = (await el.print()) as { status: string };
    return { outcome, order, printed, hostPrint, announced, polls };
  });

  expect(facts.outcome).toEqual({ status: 'printed' });
  expect(facts.polls).toBe(2);
  expect(facts.order).toEqual(['de-export-progress', 'de-export-completed']);
  expect(facts.printed).toHaveLength(1);
  expect(facts.printed[0]!.src.startsWith('blob:')).toBe(true);
  expect(facts.printed[0]!.canvases).toBe(1);
  expect(facts.printed[0]!.nonBlank).toBe(true);
  expect(facts.printed[0]!.sandboxed).toBe(false);
  expect(facts.printed[0]!.inShadowRoot).toBe(true);
  expect(facts.hostPrint).toEqual([]);
  expect(facts.announced.some((t) => /Preparing the PDF to print, 50 per cent/.test(t))).toBe(true);
});
