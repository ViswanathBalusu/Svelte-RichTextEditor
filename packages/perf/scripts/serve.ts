/**
 * Static server for the harness pages (FND-007, S5, S10). Node.js 22.18 runs this file directly.
 *
 * - `/pages/*` and `/assets/*`: the Vite build in `dist/` (scripts/build-pages.ts);
 * - `/fonts/*`: the font manifest and files; `/wasm/*`: the built text kernel (`wasm/bin`);
 * - `/corpus/<name>.cdm.json`: a corpus document, rebuilt and verified by `@docedit/corpus`, so
 *   the large documents need not be generated to disk;
 * - every response is cross-origin isolated (COOP and COEP), so that the pages can call
 *   `performance.measureUserAgentSpecificMemory()`, and is sent with `Cache-Control: no-store`,
 *   so that every load is a cold load (unless `DOCEDIT_PERF_CACHE=1`, see CACHE_ENABLED).
 *
 * Harness only: it serves on loopback addresses and trusts its paths only within its roots.
 */
import { loadDocument, serializeDocument } from '@docedit/corpus';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '..');
export const PORT = Number(process.env['DOCEDIT_PERF_PORT'] ?? 4792);
const roots = {
  dist: join(pkg, 'dist'),
  fonts: join(pkg, 'fonts'),
  wasm: join(pkg, 'wasm/bin'),
};

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * `DOCEDIT_PERF_CACHE=1` lets the browser keep what it fetched (`max-age` of one hour), so that a
 * second visit in the same context has a warm HTTP cache (FE-119 criterion 4). Without it, every
 * load is cold. The harness specs of FND-007 never set it.
 */
export const CACHE_ENABLED = process.env['DOCEDIT_PERF_CACHE'] === '1';

const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': CACHE_ENABLED ? 'public, max-age=3600' : 'no-store',
};

const corpus = new Map<string, Promise<string>>();

function send(res: ServerResponse, status: number, body: string | Uint8Array, type: string): void {
  res.writeHead(status, { 'Content-Type': type, ...ISOLATION });
  res.end(body);
}

function within(root: string, path: string): string | null {
  const full = normalize(join(root, path));
  return full === root || full.startsWith(root + sep) ? full : null;
}

async function file(res: ServerResponse, path: string | null): Promise<void> {
  if (!path) return send(res, 403, 'forbidden', 'text/plain');
  try {
    send(res, 200, await readFile(path), TYPES[extname(path)] ?? 'application/octet-stream');
  } catch {
    send(res, 404, 'not found', 'text/plain');
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = decodeURIComponent(url.pathname);
  if (path === '/health') return send(res, 200, 'ok', 'text/plain');
  const doc = /^\/corpus\/([a-z0-9-]+)\.cdm\.json$/.exec(path);
  if (doc) {
    const name = doc[1]!;
    let text = corpus.get(name);
    if (!text) {
      text = loadDocument(name).then((d) => serializeDocument(d.envelope));
      corpus.set(name, text);
    }
    try {
      return send(res, 200, await text, TYPES['.json']!);
    } catch (e) {
      corpus.delete(name);
      return send(res, 404, String(e), 'text/plain');
    }
  }
  if (path.startsWith('/fonts/'))
    return file(res, within(roots.fonts, path.slice('/fonts/'.length)));
  if (path.startsWith('/wasm/')) return file(res, within(roots.wasm, path.slice('/wasm/'.length)));
  return file(res, within(roots.dist, path.slice(1)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => send(res, 500, String(e), 'text/plain'));
  });
  server.listen(PORT, '127.0.0.1', () =>
    console.log(`perf harness server: http://127.0.0.1:${PORT}/`),
  );
}
