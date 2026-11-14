/**
 * Static server for the demo pages and the end-to-end suites (Node.js 22.18 runs this file
 * directly): `dist/demo` (the component from source with the test hooks), `/lib/` (the library
 * build, as published), `/lib/viewer/` (the PDF viewer's page, with its own policy and CORS
 * headers; FE-071) and `/exports/<name>.pdf` (signed export URLs, with CORS headers as object
 * storage sends them, and the hostile PDFs of demo/pdf-hostile.ts). The cross-origin viewer is
 * the same server reached as `localhost` while pages are on `127.0.0.1`.
 *
 * Policies are sent as response headers, never as meta tags, because some directives only work as
 * headers and workers take their policy from their own response (spike S2; ADR 0016):
 * - `/pages/<name>.html?csp=<base64url>` sends that Content-Security-Policy with the page;
 *   `{nonce}` becomes a fresh nonce (also written into the page as `__NONCE__`) and `{report}` the
 *   report endpoint of the run;
 * - any script under `/vendor/` or `/wasm/` takes its policy from `?wcsp=<base64url>`, so a test
 *   decides the policy of a same-origin worker script;
 * - `POST /csp-report?run=<id>` collects violation reports (`report-uri`), `GET /csp-reports?run=<id>`
 *   returns them, and `GET /__log?of=<id>` lists the requests of a run: those with `?run=<id>`
 *   and those under the prefix `/r/<id>/`, which a test uses for URLs a library builds itself.
 *
 * Demo only: it trusts its query string and serves on loopback addresses only.
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type FixturePart, pdfFixture } from './pdf-fixture.ts';
import { lyingCountPdf, manyPagesPdf, scriptsPdf } from './pdf-hostile.ts';
import { TINY_WASM, WORKER_SOURCE } from './wasm-worker-source.ts';

const here = dirname(fileURLToPath(import.meta.url));
const elementDir = resolve(here, '..');
// The same output directory as scripts/vite-configs.ts (`DOCEDIT_ELEMENT_DIST`, U-PRO-086-102).
const distRoot = process.env['DOCEDIT_ELEMENT_DIST']
  ? resolve(elementDir, process.env['DOCEDIT_ELEMENT_DIST'])
  : join(elementDir, 'dist');
const roots = {
  dist: join(distRoot, 'demo'),
  lib: join(distRoot, 'lib'),
  pages: join(here, 'pages'),
  vendor: join(elementDir, 'node_modules'),
};
const VENDORS = new Set(['pdfjs-dist', 'mathlive', 'katex']);
export const PORT = Number(process.env['DOCEDIT_DEMO_PORT'] ?? 4791);

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.pdf': 'application/pdf',
  '.pfb': 'application/octet-stream',
  '.bcmap': 'application/octet-stream',
  '.icc': 'application/octet-stream',
  '.svg': 'image/svg+xml',
};

interface Report {
  run: string | null;
  source: string | null;
  t: number;
  body: unknown;
}

interface LogEntry {
  t: number;
  method: string;
  path: string;
  search: string;
  run: string;
}

const reports: Report[] = [];
const log: LogEntry[] = [];

function decodePolicy(
  value: string | null,
  nonce: string,
  run: string,
  source: string,
): string | null {
  if (!value) return null;
  const policy = Buffer.from(value, 'base64url')
    .toString('utf8')
    .replaceAll('{nonce}', nonce)
    .replaceAll('{report}', `/csp-report?run=${encodeURIComponent(run)}&source=${source}`);
  if (/[\r\n]/.test(policy)) throw new Error('a policy cannot contain line breaks');
  return policy;
}

/** The demo's origins: pages on 127.0.0.1, the cross-origin viewer on localhost. */
function demoOrigins(): string {
  return `http://127.0.0.1:${PORT} http://localhost:${PORT} http://[::1]:${PORT}`;
}

function viewerPolicy(): string {
  return [
    "default-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self'",
    `connect-src 'self' ${demoOrigins()}`,
    "img-src 'self' blob: data:",
    "style-src 'self'",
    "font-src 'self'",
    `frame-ancestors ${demoOrigins()}`,
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
    'report-uri /csp-report?run=viewer&source=viewer',
  ].join('; ');
}

function within(root: string, path: string): string | null {
  const full = normalize(join(root, path));
  return full === root || full.startsWith(root + sep) ? full : null;
}

function send(
  res: ServerResponse,
  status: number,
  body: string | Buffer | Uint8Array = '',
  type = 'text/plain; charset=utf-8',
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function serveFile(
  res: ServerResponse,
  file: string | null,
  headers: Record<string, string>,
): Promise<void> {
  if (!file) return send(res, 403, 'forbidden');
  try {
    const data = await readFile(file);
    send(res, 200, data, TYPES[extname(file)] ?? 'application/octet-stream', headers);
  } catch {
    send(res, 404, 'not found');
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let path = decodeURIComponent(url.pathname);
  const q = url.searchParams;
  let run = q.get('run') ?? 'none';
  // `/r/<run>/…` tags requests whose URLs a library builds itself (PDF.js's WebAssembly files).
  const tagged = /^\/r\/([A-Za-z0-9_-]+)(\/.*)$/.exec(path);
  if (tagged) {
    run = tagged[1]!;
    path = tagged[2]!;
  }
  log.push({ t: Date.now(), method: req.method ?? 'GET', path, search: url.search, run });

  if (path === '/health') return send(res, 200, 'ok');
  if (path === '/csp-report' && req.method === 'POST') {
    const text = await readBody(req);
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // Keep the text.
    }
    reports.push({ run: q.get('run'), source: q.get('source'), t: Date.now(), body });
    return send(res, 204);
  }
  if (path === '/csp-reports')
    return send(
      res,
      200,
      JSON.stringify(reports.filter((r) => r.run === q.get('run'))),
      'application/json',
    );
  if (path === '/__log') {
    const since = Number(q.get('since') ?? 0);
    const of = q.get('of');
    return send(
      res,
      200,
      JSON.stringify(log.filter((e) => e.t >= since && (of === null || e.run === of))),
      'application/json',
    );
  }

  const nonce = randomBytes(16).toString('base64');
  const headers: Record<string, string> = {};
  try {
    const page = decodePolicy(q.get('csp'), nonce, run, 'page');
    if (page) headers['Content-Security-Policy'] = page;
    const worker = decodePolicy(q.get('wcsp'), nonce, run, 'worker');
    if (worker && (path.startsWith('/vendor/') || path.startsWith('/wasm/')))
      headers['Content-Security-Policy'] = worker;
  } catch (e) {
    return send(res, 400, (e as Error).message);
  }

  if (path === '/pdf/sample.pdf') return send(res, 200, pdfFixture(), 'application/pdf', headers);
  // The same bytes XOR 0x5A, for environments whose filters replace PDF responses: on the machine
  // of spike S2 a local filter answered 204 to firefox.exe and msedge.exe for the PDF bytes, under
  // any content type. The test decodes them in the page and hands PDF.js the data.
  if (path === '/pdf/sample.xor') {
    const parts = q
      .get('parts')
      ?.split(',')
      .filter((p): p is FixturePart => ['fill', 'image', 'text'].includes(p));
    return send(
      res,
      200,
      pdfFixture(parts).map((b) => b ^ 0x5a),
      'application/octet-stream',
      headers,
    );
  }
  // A signed export URL (FE-071): the viewer's frame fetches it from its own origin, so it carries
  // CORS headers as object storage would. `.xor` is the same bytes for the filtered browsers.
  const exported = /^\/exports\/([a-z-]+)\.(pdf|xor)$/.exec(path);
  if (exported) {
    const origin = `http://${req.headers.host ?? `127.0.0.1:${PORT}`}`;
    const pdfs: Record<string, () => Buffer> = {
      sample: () => pdfFixture(),
      scripts: () => scriptsPdf(origin),
      pages: () => manyPagesPdf(Math.min(Number(q.get('pages') ?? 10_000), 50_000)),
      lying: () => lyingCountPdf(),
    };
    const make = pdfs[exported[1]!];
    if (!make) return send(res, 404, 'not found');
    const bytes = make();
    return send(
      res,
      200,
      exported[2] === 'xor' ? bytes.map((b) => b ^ 0x5a) : bytes,
      exported[2] === 'xor' ? 'application/octet-stream' : 'application/pdf',
      { 'Access-Control-Allow-Origin': '*' },
    );
  }
  // Where a hostile PDF's scripts would call: a request here means a script ran.
  if (path === '/pwned')
    return send(res, 204, '', 'text/plain', { 'Access-Control-Allow-Origin': '*' });
  if (path.startsWith('/lib/')) {
    const file = within(roots.lib, path.slice('/lib/'.length));
    if (path.startsWith('/lib/viewer/'))
      return serveFile(res, file, {
        // The viewer's own response policy (FE-071; spike S2 §8): no inline script or style, no
        // eval (`'wasm-unsafe-eval'` allows only WebAssembly compilation), embeddable only by the
        // demo's pages; the frame fetches signed URLs from the demo origins.
        'Content-Security-Policy': viewerPolicy(),
        // An opaque (sandboxed, same-origin) viewer loads its module scripts in CORS mode.
        'Access-Control-Allow-Origin': '*',
      });
    return serveFile(res, file, {});
  }
  if (path === '/wasm/worker.js') return send(res, 200, WORKER_SOURCE, TYPES['.js'], headers);
  if (path === '/wasm/tiny.wasm')
    return send(res, 200, Uint8Array.from(TINY_WASM), TYPES['.wasm'], headers);

  if (path.startsWith('/pages/')) {
    const file = within(roots.pages, path.slice('/pages/'.length));
    if (!file) return send(res, 403, 'forbidden');
    try {
      const html = (await readFile(file, 'utf8')).replaceAll('__NONCE__', nonce);
      return send(res, 200, html, TYPES['.html'], headers);
    } catch {
      return send(res, 404, 'not found');
    }
  }
  if (path.startsWith('/vendor/')) {
    const [, , name, ...rest] = path.split('/');
    if (!name || !VENDORS.has(name)) return send(res, 404, 'not found');
    return serveFile(res, within(join(roots.vendor, name), rest.join('/')), headers);
  }
  if (path === '/' || path === '')
    return send(res, 302, '', 'text/plain', { Location: '/pages/s1.html' });
  return serveFile(res, within(roots.dist, path), {});
}

function listen(host: string): Promise<void> {
  return new Promise((done) => {
    const server = createServer((req, res) => {
      handle(req, res).catch((e: unknown) => send(res, 500, String(e)));
    });
    server.on('error', (e) => {
      console.warn(`demo server: not listening on ${host}: ${(e as Error).message}`);
      done();
    });
    server.listen(PORT, host, () => {
      console.log(`demo server: http://${host.includes(':') ? `[${host}]` : host}:${PORT}/`);
      done();
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await listen('127.0.0.1');
  await listen('::1');
}
