/**
 * FE-073 (lane V-FE-065-080): a probe of the printing path the story needs. The viewer's frame is
 * sandboxed (FE-071: `allow-scripts allow-same-origin` only, never `allow-modals`). Printing from
 * inside that frame calls `window.print()` in the frame's own document, so the question is whether
 * the browser lets a sandboxed frame without `allow-modals` print at all.
 *
 * What this file records, per browser:
 * - the viewer frame's `sandbox` attribute, which must not contain `allow-modals` (FE-071);
 * - the result of `window.print()` called inside the frame: whether the call returned, and any
 *   console message the browser reports about the sandbox (Chromium says it ignored the call).
 *
 * It does not print anything: the call is made in a headless browser and nothing is sent to a
 * printer. It answers the question that the proposed ADR 0304 (lane V-FE-065-080) decides on.
 *
 * Run from the repository root with
 * `DOCEDIT_DEMO_PORT=57040 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-073-print-sandbox.spec.ts --project=chromium --project=firefox --project=webkit`.
 */
import { expect, test, type Page } from '@playwright/test';
import { FILTERED_BROWSERS, openEmbed } from './embed-helpers.ts';

const PORT = Number(process.env['DOCEDIT_DEMO_PORT'] ?? 4791);
const VIEWER = `http://localhost:${PORT}/lib/viewer/pdf-viewer.html`;

/** Opens the viewer frame with the demo's sample PDF, as pdf-viewer.spec.ts does. */
async function openViewer(page: Page): Promise<void> {
  await openEmbed(page);
  await page.evaluate(
    async ({ viewer, filtered }) => {
      const e = (
        window as unknown as {
          __embed: {
            backend(s: string): unknown;
            docId: string;
            openPdf(el: Element, s: unknown): Promise<unknown>;
          };
        }
      ).__embed;
      const el = document.createElement('doc-editor') as HTMLElement & Record<string, unknown>;
      el.dataset['test'] = 'one';
      el['config'] = { pdfViewerUrl: viewer };
      el['backend'] = e.backend('ada');
      el.setAttribute('doc-id', e.docId);
      const ready = new Promise((r) => el.addEventListener('de-ready', r, { once: true }));
      document.getElementById('mount')!.append(el);
      await ready;
      const signed = `http://127.0.0.1:${location.port}/exports/sample.pdf?sig=test-signature`;
      let source: unknown = { url: signed };
      if (filtered) {
        const coded = new Uint8Array(
          await (await fetch('/exports/sample.xor?sig=test-signature')).arrayBuffer(),
        );
        source = { data: coded.map((b) => b ^ 0x5a).buffer };
      }
      await e.openPdf(el, source);
    },
    { viewer: VIEWER, filtered: FILTERED_BROWSERS.has(test.info().project.name) },
  );
}

test('the viewer frame is sandboxed without allow-modals, and window.print() inside it is reported (FE-073 probe)', async ({
  page,
  browserName,
}) => {
  const messages: string[] = [];
  page.on('console', (m) => messages.push(m.text()));
  await openViewer(page);

  const sandbox = await page.evaluate(() =>
    document
      .querySelector('doc-editor[data-test="one"]')!
      .shadowRoot!.querySelector('iframe')!
      .getAttribute('sandbox'),
  );
  expect(sandbox ?? '').not.toContain('allow-modals');

  const viewer = page
    .frames()
    .find((f) => f.url().startsWith(VIEWER.split('/lib')[0]!) && f !== page.mainFrame());
  expect(viewer, 'the viewer frame is found').toBeTruthy();
  const returned = await viewer!.evaluate(() => {
    try {
      window.print();
      return 'returned';
    } catch (e) {
      return `threw: ${e instanceof Error ? e.name : String(e)}`;
    }
  });

  // Recorded for the ADR; the assertion only requires that the call returned (no hang, no throw).
  console.log(
    `FE-073 probe ${browserName}: sandbox="${sandbox}" print()=${returned} messages=${JSON.stringify(
      messages.filter((t) => /print|sandbox|modal/i.test(t)),
    )}`,
  );
  expect(returned).toBe('returned');
});
