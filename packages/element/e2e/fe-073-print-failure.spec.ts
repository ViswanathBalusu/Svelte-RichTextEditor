/**
 * FE-073 criterion 4 and the browser half of criterion 2 (lane w1): `print()` on the element asks
 * for a typeset PDF, and when the export job fails the failure reaches the host as `de-export-*`
 * events and `de-error`, in that order, and nothing is printed: no frame is created, the host
 * page's `window.print` is not called, and the element's style sheets hold no `@media print` and no
 * `@page` rule.
 *
 * The backend is the embed page's in-memory mock with a stand-in `exports` port (the mock has
 * none): the job is `converting` on the first poll and `failed` on the second. A job that completes
 * is not run here: a headless browser shows no print dialogue, so a print that happens cannot be
 * told from one that does not (see FE-073's Notes).
 *
 * Run from the repository root with
 * `DOCEDIT_DEMO_PORT=57173 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-073-print-failure.spec.ts`
 * in Chromium, Firefox and WebKit.
 */
import { expect, test } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';

test('FE-073: a failed export is reported through the export events and de-error, and nothing is printed', async ({
  page,
}) => {
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
    const requests: unknown[] = [];
    backend.exports = {
      request: async (docId: string, body: unknown) => {
        requests.push([docId, body]);
        return { id: 'job-fe-073', docId, state: 'queued', progress: null, target: 'pdf' };
      },
      get: async () => {
        polls += 1;
        return polls === 1
          ? { id: 'job-fe-073', state: 'converting', progress: 0.5, result: null }
          : {
              id: 'job-fe-073',
              state: 'failed',
              progress: null,
              result: null,
              error: { code: 'internal', message: 'the typesetter failed' },
            };
      },
      cancel: async () => {},
    };

    const printed: string[] = [];
    window.print = () => {
      printed.push('window.print');
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
    document.getElementById('mount')!.append(el);
    await ready;
    order.length = 0;

    const frames: string[] = [];
    new MutationObserver((records) => {
      for (const r of records)
        for (const n of Array.from(r.addedNodes))
          if (n instanceof Element && (n.localName === 'iframe' || n.querySelector('iframe')))
            frames.push(n.localName);
    }).observe(el.shadowRoot!, { childList: true, subtree: true });

    const outcome = (await el.print()) as { status: string; code?: string; message?: string };
    await new Promise((r) => setTimeout(r, 300));

    const rules: string[] = [];
    const visit = (list: CSSRuleList): void => {
      for (const rule of Array.from(list)) {
        if (rule instanceof CSSPageRule) rules.push(rule.cssText);
        else if (rule instanceof CSSMediaRule) {
          if (/print/i.test(rule.conditionText)) rules.push(rule.cssText);
          visit(rule.cssRules);
        }
      }
    };
    for (const sheet of el.shadowRoot!.adoptedStyleSheets) visit(sheet.cssRules);
    return {
      outcome,
      order,
      printed,
      frames,
      polls,
      requests: requests.length,
      printRules: rules,
      sheets: el.shadowRoot!.adoptedStyleSheets.length,
    };
  });

  expect(facts.requests).toBe(1);
  expect(facts.polls).toBe(2);
  expect(facts.outcome).toMatchObject({ status: 'failed', message: 'the typesetter failed' });
  expect(facts.order).toEqual(['de-export-progress', 'de-export-failed', 'de-error']);
  // Nothing is printed: no frame, no call of the host page's window.print.
  expect(facts.frames).toEqual([]);
  expect(facts.printed).toEqual([]);
  // The element's sheets carry no print rule (and there are sheets to look in).
  expect(facts.sheets).toBeGreaterThan(0);
  expect(facts.printRules).toEqual([]);
});
