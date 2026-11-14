/**
 * The element's distributable, served as a host serves a component it installed: the module
 * `doc-editor.js`, its lazily loaded chunks and assets, and the PDF viewer's page (FE-002, FE-071).
 * The page loads the module from here; the viewer is opened from the host's second origin and gets
 * its own policy: no inline code, no eval, framed only by the host's pages, fetching only exported
 * files from the object store.
 */
import { error } from '@sveltejs/kit';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { host } from '../../../lib/server/host.ts';
import type { RequestHandler } from './$types';

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
  '.pfb': 'application/octet-stream',
  '.bcmap': 'application/octet-stream',
  '.icc': 'application/octet-stream',
  '.svg': 'image/svg+xml',
};

let resolvedDir: string | null = null;

/** `packages/element/dist/lib`, built by the element's `build` script (FE-002). */
function elementDir(configured: string | null): string {
  if (configured) return configured;
  resolvedDir ??= join(
    dirname(createRequire(import.meta.url).resolve('@docedit/element')),
    '..',
    'dist',
    'lib',
  );
  return resolvedDir;
}

function viewerPolicy(pageOrigins: readonly string[], exportOrigins: readonly string[]): string {
  return [
    "default-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self'",
    `connect-src 'self' ${exportOrigins.join(' ')}`.trim(),
    "img-src 'self' blob: data:",
    "style-src 'self'",
    "font-src 'self'",
    `frame-ancestors ${pageOrigins.length ? pageOrigins.join(' ') : "'none'"}`,
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join('; ');
}

export const GET: RequestHandler = async ({ params }) => {
  const h = await host();
  const root = normalize(elementDir(h.config.elementDir));
  const file = normalize(join(root, params.path));
  if (!file.startsWith(root + sep)) error(404, 'Not found');
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch {
    error(404, 'Not found');
  }
  const headers: Record<string, string> = {
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  };
  if (params.path.startsWith('viewer/'))
    headers['Content-Security-Policy'] = viewerPolicy(h.config.pageOrigins, h.config.exportOrigins);
  return new Response(new Uint8Array(bytes), { headers });
};
