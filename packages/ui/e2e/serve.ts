/**
 * Serves the built harness (dist/harness) for Playwright: `node e2e/serve.ts`. Every page is sent
 * with the strict policy of spike S2 as a response header (no unsafe keyword, Trusted Types with no
 * policy allowed), so every test also checks that the shell needs nothing more. `'report-sample'`
 * only adds the start of a blocked inline script or style to the event, to name its source. `?csp=off` serves
 * a page without it, for debugging only.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { outDir } from './vite-config.ts';

export const STRICT_POLICY = [
  "default-src 'none'",
  "script-src 'self' 'report-sample'",
  "style-src 'self' 'report-sample'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "require-trusted-types-for 'script'",
  "trusted-types 'none'",
].join('; ');

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// 4791 is the element's demo and 4792 the performance harness (packages/perf).
const port = Number(process.env['DOCEDIT_UI_PORT'] ?? 4796);

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }
  const path = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = normalize(join(outDir, decodeURIComponent(path)));
  if (!file.startsWith(outDir) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    return;
  }
  const headers: Record<string, string> = {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  };
  if (url.pathname === '/sandbox-frame.html') {
    // The page of a sandboxed extension's frame (UX-060): opaque origin, no network, its own scripts.
    headers['content-security-policy'] =
      "sandbox allow-scripts; default-src 'none'; script-src 'self'";
  } else if (extname(file) === '.html' && url.searchParams.get('csp') !== 'off') {
    // `?frame-src=self` lets one page embed frames of its own origin, for the sandboxed panel (UX-060).
    headers['content-security-policy'] =
      url.searchParams.get('frame-src') === 'self'
        ? STRICT_POLICY.replace("frame-src 'none'", "frame-src 'self'")
        : STRICT_POLICY;
  }
  res.writeHead(200, headers);
  createReadStream(file).pipe(res);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`ui harness: http://127.0.0.1:${port}/`);
});
