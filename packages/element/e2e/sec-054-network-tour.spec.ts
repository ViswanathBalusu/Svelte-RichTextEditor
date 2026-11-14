/**
 * SEC-054 criterion 1 (10 §3.8; ADR 0044 §6), lane U-SEC-049-064: a recorded browser tour of the
 * element's pages. Every request made while the tour runs (scripts, styles, fonts, WebAssembly,
 * workers, images, data and fetches) must go to the demo's own origin, or be a data: or blob: URL
 * built in the page. The tour covers the embed page (typing, a second editor, a reconnect) and the
 * library build loaded by URL, and the wasm page. It does not yet drive the PDF viewer, the math
 * editor or the proofing and assistant ports under the recorder, so criterion 1 stays unticked
 * until those are added to the tour (the evidence is written to test-results/evidence).
 */
import { type Request as PwRequest, expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { record, runId } from './helpers.ts';
import { mountEditor, openEmbed, openLib } from './embed-helpers.ts';

const EVIDENCE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'test-results',
  'evidence',
  'sec-054-network-tour',
);

/** Requests that the tour allows to leave the demo origin: none. */
const ALLOWED_SCHEMES = new Set(['data:', 'blob:']);

test.describe('SEC-054 criterion 1: the recorded tour loads nothing from another origin', () => {
  test('embed, library and wasm pages, typing and a second editor', async ({ page, baseURL }) => {
    const origin = new URL(baseURL ?? 'http://127.0.0.1:4791').origin;
    const seen: Array<{ url: string; type: string; resourceType: string; page: string }> = [];
    const failed: string[] = [];
    const onRequest = (req: PwRequest) => {
      seen.push({
        url: req.url(),
        type: req.method(),
        resourceType: req.resourceType(),
        page: req.frame().url(),
      });
    };
    page.on('request', onRequest);
    page.on('requestfailed', (req) => failed.push(req.url()));

    await openEmbed(page);
    await mountEditor(page, { name: 'tour' });
    const editing = page.locator('doc-editor[data-test="tour"]');
    await editing.locator('.de-editing-surface').first().waitFor();
    await page.keyboard.press('Tab');
    await page.keyboard.type(' tour text');
    await page.keyboard.press('ControlOrMeta+b');
    await page.keyboard.type(' bold');
    await mountEditor(page, { name: 'tour-two', doc: 'second' });

    await openLib(page);
    await page.goto('/pages/wasm.html');
    await page.waitForLoadState('networkidle');

    page.off('request', onRequest);

    const remote = seen.filter((r) => {
      const u = new URL(r.url);
      return !ALLOWED_SCHEMES.has(u.protocol) && u.origin !== origin;
    });
    const hosts = [...new Set(seen.map((r) => new URL(r.url).origin))].sort();
    const run = runId();
    mkdirSync(EVIDENCE, { recursive: true });
    writeFileSync(
      join(EVIDENCE, `${run}.json`),
      JSON.stringify({ origin, requests: seen.length, hosts, remote, failed }, null, 2),
    );
    record('sec-054-network-tour', { run, browser: test.info().project.name, hosts, remote });

    expect(seen.length).toBeGreaterThan(0);
    expect(remote).toEqual([]);
  });
});
