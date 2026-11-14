/**
 * SEC-054 criterion 1, the PDF viewer part of the recorded tour (10 §3.8; ADR 0044 §6), lane
 * U-SEC-049-064. The viewer is a configured service (`pdfViewerUrl`), so the requests it makes on
 * its own origin are allowed by the criterion ("the host's origin or the configured service"). This
 * test records every request made while an export is drawn in the viewer and fails if any request
 * goes to an origin other than the demo's and the configured viewer's. The viewer's frame and its
 * worker are recorded through the page's request events, which include frame requests.
 *
 * Not covered here: the math editor, and the proofing and assistant ports. Criterion 1 stays open
 * until they are added to the tour.
 */
import { type Page, type Request, expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { record, runId } from './helpers.ts';
import { FILTERED_BROWSERS, openEmbed } from './embed-helpers.ts';

const PORT = Number(process.env['DOCEDIT_DEMO_PORT'] ?? 4791);
const VIEWER = `http://localhost:${PORT}/lib/viewer/pdf-viewer.html`;
const DEMO_ORIGIN = `http://127.0.0.1:${PORT}`;
const VIEWER_ORIGIN = `http://localhost:${PORT}`;

const EVIDENCE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'test-results',
  'evidence',
  'sec-054-network-tour',
);

/** Mounts a `<doc-editor>` whose PDF viewer is the configured one, then waits for `de-ready`. */
async function openWithViewer(page: Page): Promise<void> {
  await openEmbed(page);
  await page.evaluate(async (viewer) => {
    const e = (window as unknown as { __embed: { backend(s: string): unknown; docId: string } })
      .__embed;
    const el = document.createElement('doc-editor') as HTMLElement & Record<string, unknown>;
    el.dataset['test'] = 'one';
    el['config'] = { pdfViewerUrl: viewer };
    el['backend'] = e.backend('ada');
    el.setAttribute('doc-id', e.docId);
    const ready = new Promise((r) => el.addEventListener('de-ready', r, { once: true }));
    document.getElementById('mount')!.append(el);
    await ready;
  }, VIEWER);
}

/** Draws the export in the viewer: from its signed URL, or from its bytes where filtered. */
async function openPdf(page: Page, how: 'url' | 'data'): Promise<{ pages: number }> {
  return page.evaluate(
    async ({ how, port }) => {
      const e = (
        window as unknown as {
          __embed: {
            openPdf(el: Element, s: unknown): Promise<{ pages: number }>;
          };
        }
      ).__embed;
      const el = document.querySelector('doc-editor[data-test="one"]')!;
      let source: unknown = {
        url: `http://127.0.0.1:${port}/exports/sample.pdf?sig=test-signature`,
      };
      if (how === 'data') {
        const coded = new Uint8Array(
          await (await fetch('/exports/sample.xor?sig=test-signature')).arrayBuffer(),
        );
        source = { data: coded.map((b) => b ^ 0x5a).buffer };
      }
      const r = await e.openPdf(el, source);
      return { pages: r.pages };
    },
    { how, port: PORT },
  );
}

test.describe('SEC-054 criterion 1: the PDF viewer loads only from the demo and its configured viewer', () => {
  test('drawing an export in the sandboxed viewer makes no request elsewhere', async ({
    page,
  }, info) => {
    const seen: Array<{ url: string; resourceType: string; frame: string }> = [];
    const failed: string[] = [];
    const onRequest = (req: Request) => {
      seen.push({ url: req.url(), resourceType: req.resourceType(), frame: req.frame().url() });
    };
    page.on('request', onRequest);
    page.on('requestfailed', (req) => failed.push(req.url()));

    await openWithViewer(page);
    const how = FILTERED_BROWSERS.has(info.project.name) ? 'data' : 'url';
    const drawn = await openPdf(page, how);
    expect(drawn.pages).toBe(1);
    // The viewer's frame is on its own origin: the request record must show it fetched something.
    expect(seen.some((r) => r.frame.startsWith(VIEWER))).toBe(true);

    page.off('request', onRequest);

    const allowed = new Set([DEMO_ORIGIN, VIEWER_ORIGIN]);
    const remote = seen.filter((r) => {
      const u = new URL(r.url);
      return u.protocol !== 'data:' && u.protocol !== 'blob:' && !allowed.has(u.origin);
    });
    const hosts = [...new Set(seen.map((r) => new URL(r.url).origin))].sort();
    const run = runId();
    mkdirSync(EVIDENCE, { recursive: true });
    writeFileSync(
      join(EVIDENCE, `pdf-${run}.json`),
      JSON.stringify(
        { demo: DEMO_ORIGIN, viewer: VIEWER_ORIGIN, requests: seen.length, hosts, remote, failed },
        null,
        2,
      ),
    );
    record('sec-054-network-tour-pdf', {
      run,
      browser: info.project.name,
      how,
      hosts,
      remote,
    });

    expect(remote).toEqual([]);
  });
});
