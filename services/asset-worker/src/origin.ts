/**
 * The asset origin (BE-045 criteria 2 to 5; SEC-040 criteria 4 and 5; SEC-046 criteria 2 to 4;
 * 10 §3.5 "assets are served with fixed content types and nosniff from a separate origin"). A small
 * HTTP server, deployed on a site of its own (never the application's site or a subdomain of it),
 * that checks a signed URL (signing.ts), reads the one object it names with read-only credentials,
 * checks that the bytes still have the hash the URL names, and serves them with:
 *
 * - a fixed content type for the kind, never one taken from the store or the request;
 * - `X-Content-Type-Options: nosniff`;
 * - `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`, so a file
 *   opened as a page runs no script and loads nothing;
 * - `Content-Disposition: attachment` for SVG, PDF and Word files, so they are never rendered as a
 *   page (`<img>` still shows an SVG, without scripts or external loads);
 * - `Cross-Origin-Resource-Policy: cross-origin` (pages of the application embed the images) and
 *   `Referrer-Policy: no-referrer`;
 * - long caching: assets are immutable and content-addressed, the URL changes when it is re-signed.
 *
 * Anything else answers 403 or 404 with no detail, and nothing is cached.
 *
 * The result files of an export job (`/e/{tenant}/{job}/{name}`, SEC-036 criterion 6; owner decision
 * 66) come out of the same handler with the same headers: the content type is fixed by the file's
 * extension (signing.ts `EXPORT_SERVED`), every result is `attachment`, and the answer is
 * `private, no-store` because a job's files are not content-addressed.
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { assetKeys } from './keys.ts';
import type { AssetObjects } from './objects.ts';
import { URL_DEFAULTS, verifyAssetUrl, verifyExportUrl, type AssetUrlKeys } from './signing.ts';

export interface AssetOriginOptions {
  objects: Pick<AssetObjects, 'get'>;
  keys: AssetUrlKeys;
  now?: () => number;
  /** Largest object served, bytes. */
  maxBytes?: number;
  /** URLs that expire later than this from now are refused (ms). */
  maxLifetimeMs?: number;
  cacheControl?: string;
  /** Called for every refused request, with the reason (no content, no full URL). */
  onRefused?: (reason: string) => void;
}

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'Referrer-Policy': 'no-referrer',
};

function refuse(res: ServerResponse, status: number, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extra,
  });
  res.end(status === 404 ? 'not found\n' : status === 405 ? 'method not allowed\n' : 'forbidden\n');
}

/** The request handler of the asset origin. */
export function assetOriginHandler(
  opts: AssetOriginOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  const now = opts.now ?? Date.now;
  const maxBytes = opts.maxBytes ?? 64 * 1024 * 1024;
  const cacheControl = opts.cacheControl ?? 'private, max-age=31536000, immutable';
  /** A result file of an export job. */
  const serveExport = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const check = verifyExportUrl(
      req.url ?? '',
      opts.keys,
      now(),
      opts.maxLifetimeMs ?? URL_DEFAULTS.maxLifetimeMs,
    );
    if (!check.ok) {
      opts.onRefused?.(check.reason);
      return refuse(res, check.reason === 'not_found' ? 404 : 403);
    }
    let body: Uint8Array | null;
    try {
      body = await opts.objects.get(
        assetKeys.exportFile(check.tenant, check.job, check.name),
        maxBytes,
      );
    } catch {
      opts.onRefused?.('store');
      return refuse(res, 503);
    }
    if (!body) {
      opts.onRefused?.('missing');
      return refuse(res, 404);
    }
    const headers: Record<string, string> = {
      ...SECURITY_HEADERS,
      'Content-Type': check.kind.contentType,
      'Content-Disposition': `attachment; filename="${check.name}"`,
      'Cache-Control': 'private, no-store',
      // The element reads `layout.json` and the viewer reads the PDF with a `fetch` from the
      // host's origin. The URL is a signed capability and the request carries no credentials, so
      // any origin may read what the URL names.
      'Access-Control-Allow-Origin': '*',
      'Content-Length': String(body.length),
    };
    res.writeHead(200, headers);
    res.end(
      req.method === 'HEAD'
        ? undefined
        : Buffer.from(body.buffer, body.byteOffset, body.byteLength),
    );
  };
  return (req, res) => {
    void (async () => {
      if (req.method !== 'GET' && req.method !== 'HEAD')
        return refuse(res, 405, { Allow: 'GET, HEAD' });
      if ((req.url ?? '').startsWith('/e/')) return serveExport(req, res);
      const check = verifyAssetUrl(
        req.url ?? '',
        opts.keys,
        now(),
        opts.maxLifetimeMs ?? URL_DEFAULTS.maxLifetimeMs,
      );
      if (!check.ok) {
        opts.onRefused?.(check.reason);
        return refuse(res, check.reason === 'not_found' ? 404 : 403);
      }
      const etag = `"${check.sha256}"`;
      let body: Uint8Array | null;
      try {
        body = await opts.objects.get(assetKeys.final(check.tenant, check.sha256), maxBytes);
      } catch {
        opts.onRefused?.('store');
        return refuse(res, 503);
      }
      if (!body) {
        opts.onRefused?.('missing');
        return refuse(res, 404);
      }
      if (createHash('sha256').update(body).digest('hex') !== check.sha256) {
        opts.onRefused?.('hash_mismatch');
        return refuse(res, 502);
      }
      const headers: Record<string, string> = {
        ...SECURITY_HEADERS,
        'Content-Type': check.kind.contentType,
        'Content-Disposition':
          check.kind.disposition === 'inline'
            ? 'inline'
            : `attachment; filename="${check.sha256}.${check.kind.ext}"`,
        'Cache-Control': cacheControl,
        ETag: etag,
      };
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers);
        res.end();
        return;
      }
      headers['Content-Length'] = String(body.length);
      res.writeHead(200, headers);
      res.end(
        req.method === 'HEAD'
          ? undefined
          : Buffer.from(body.buffer, body.byteOffset, body.byteLength),
      );
    })().catch(() => {
      if (!res.headersSent) refuse(res, 500);
      else res.destroy();
    });
  };
}

export interface RunningOrigin {
  server: Server;
  /** For example `http://127.0.0.1:41234`. */
  url: string;
  close(): Promise<void>;
}

/** Starts the asset origin on `host:port` (port 0 picks a free one). */
export function startAssetOrigin(
  opts: AssetOriginOptions & { host?: string; port?: number },
): Promise<RunningOrigin> {
  const server = createServer(assetOriginHandler(opts));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => {
      const a = server.address() as AddressInfo;
      const host = a.family === 'IPv6' ? `[${a.address}]` : a.address;
      resolve({
        server,
        url: `http://${host}:${a.port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
