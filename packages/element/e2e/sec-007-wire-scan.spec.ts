/**
 * SEC-007 criterion 2 (lane V-SEC-001-016): a session of the element against the real wire
 * service (the security harness in tests/security/test/support/harness.ts, memory storage), not the
 * in-memory demo transport. The element's default endpoint factory is the DEP client, so its
 * requests and its WebSocket go to the harness. Afterwards no token may appear in any request
 * address or body, any WebSocket address, or any console line or `de-*` event detail, including
 * the export address the session asks for.
 *
 * The token is a host-signed user token of the harness tenant (its key is the host's key, 05 §3.1).
 * The WebSocket frames carry the token in `hello`; the criterion covers addresses, so frames are
 * not scanned as addresses, but the request and WebSocket addresses are scanned for the token and
 * its bare value. Storage, cookies and history are scanned by sec-007-token-scan.spec.ts.
 * The harness's origin allow-list is given the demo page's origin for tenant a.
 */
import { expect, test } from '@playwright/test';
import { startHarness } from '../../../tests/security/test/support/harness.ts';
import { openEmbed } from './embed-helpers.ts';

const DEMO_PORT = Number(process.env['DOCEDIT_DEMO_PORT'] ?? 4791);
const ORIGIN = `http://127.0.0.1:${DEMO_PORT}`;

test('SEC-007: a session against the wire service leaves no token in any request, WebSocket address, console or event', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const h = await startHarness('memory', { port: 0 });
  try {
    await h.parts.registry.addOrigin(h.a.id, ORIGIN);
    const docId = await h.createDocument(h.a);
    const token = h.userToken(h.a, 'ada', { [docId]: 'editor' });
    const bare = token.slice(-40);

    const seen: string[] = [];
    page.on('request', (r) => {
      seen.push(r.url());
      const body = r.postData();
      if (body) seen.push(body);
    });
    page.on('websocket', (ws) => seen.push(ws.url()));
    const consoleLines: string[] = [];
    page.on('console', (m) => consoleLines.push(m.text()));
    page.on('pageerror', (err) => consoleLines.push(err.message));

    await openEmbed(page);
    await page.evaluate(
      async ({ endpoint, docId, token }) => {
        const el = document.createElement('doc-editor') as HTMLElement & Record<string, unknown>;
        el.dataset['test'] = 'sec-007-wire';
        el.setAttribute('endpoint', endpoint);
        el.setAttribute('doc-id', docId);
        el['getToken'] = async () => token;
        const ready = new Promise<void>((resolve, reject) => {
          el.addEventListener('de-ready', () => resolve(), { once: true });
          el.addEventListener(
            'de-error',
            (ev) => reject(new Error(JSON.stringify((ev as CustomEvent).detail))),
            { once: true },
          );
        });
        document.getElementById('mount')!.append(el);
        await ready;
      },
      { endpoint: h.base, docId, token },
    );

    const surface = page.locator('doc-editor[data-test="sec-007-wire"] .de-editing-surface');
    await expect(surface).toBeVisible();
    await surface.locator('p').last().click();
    await page.keyboard.press('End');
    await page.keyboard.type(' sec007wire');
    await expect
      .poll(() => surface.evaluate((el) => el.textContent ?? ''), { timeout: 15_000 })
      .toContain('sec007wire');

    // The element's requestExport refuses when the server announces no export feature, and the
    // harness announces none, so the export address is asked for directly with the same bearer
    // token the session uses. The request is a page request, so the scan below sees its address.
    const exportStatus = await page.evaluate(
      async ({ endpoint, docId, token }) => {
        const el = document.querySelector('doc-editor[data-test="sec-007-wire"]') as HTMLElement & {
          flush(): Promise<void>;
        };
        await el.flush();
        const response = await fetch(`${endpoint}/v1/documents/${docId}/exports`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': 'sec-007-wire-export-1',
          },
          body: JSON.stringify({ target: 'pdf', options: { profile: 'final' } }),
        });
        return response.status;
      },
      { endpoint: h.base, docId, token },
    );
    await page.waitForTimeout(500);

    expect(exportStatus, 'the export request was accepted by the service').toBeGreaterThanOrEqual(
      200,
    );
    expect(exportStatus, 'the export request was accepted by the service').toBeLessThan(300);
    expect(
      seen.some((s) => s.includes('/exports')),
      'the session asked for an export',
    ).toBe(true);
    expect(
      seen.some((s) => s.startsWith('ws')),
      'the session opened a WebSocket',
    ).toBe(true);
    const events = await page.evaluate(() =>
      JSON.stringify((window as unknown as { __embed: { events: unknown[] } }).__embed.events),
    );
    for (const s of seen) expect(s, 'request address or body holds no token').not.toContain(bare);
    for (const line of consoleLines) expect(line, 'console holds no token').not.toContain(bare);
    expect(events, 'de-* events hold no token').not.toContain(bare);
  } finally {
    await h.close();
  }
});
