/**
 * The HTTP binding of the authority service (ADR 0314 decision 3; owner decision 193, 2026-11-15:
 * accepted as the starting point). Each call of 05 §10 is one request and one response, the state
 * identifier is in the path, and bodies are canonical JSON. `open` also accepts newline-delimited
 * JSON for a long log: the first line is `{ checkpointRef, stateId }`, each next line one commit.
 * HTTP/1.1 is what Node.js serves here; the first sidecar needs no more (ADR 0314).
 *
 * | Call | Route |
 * |---|---|
 * | `open` | `POST /v1/authority/documents/{doc}/open` |
 * | `materialise` | `GET /v1/authority/states/{stateId}/content?seq=N` |
 * | `migrate` | `POST /v1/authority/states/{stateId}/migrate` |
 * | `evaluateRules` | `POST /v1/authority/states/{stateId}/evaluate-rules` |
 *
 * A failed call is `application/problem+json` with the service's `code` (RFC 9457). Probes are
 * `GET /v1/authority/health` (the process is up) and `GET /v1/authority/ready` (it can serve).
 */
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { canonicalize } from '@docedit/model';
import type { Answer, AuthorityService, ServiceError, ServiceErrorCode } from './service.ts';

/** The status of each failure. A rejection of a commit is an answer, not an error (not here yet). */
export const STATUS: Readonly<Record<ServiceErrorCode, number>> = {
  invalid_request: 400,
  unknown_state: 404,
  not_found: 404,
  checkpoint_unavailable: 404,
  state_mismatch: 409,
  chain_broken: 409,
  checkpoint_mismatch: 409,
  payload_missing: 422,
  replay_failed: 422,
  unsupported_cdm: 422,
  unsupported_feature: 422,
  validation_failed: 422,
  migration_not_enabled: 403,
  migration_failed: 422,
  invalid_rules: 422,
  budget_exceeded: 422,
};

export const API = '/v1/authority';

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const JSON_TYPE = 'application/json';

function json(status: number, value: unknown, extra: Record<string, string> = {}): HttpResponse {
  return {
    status,
    headers: { 'content-type': JSON_TYPE, ...extra },
    body: canonicalize(value),
  };
}

export function problem(error: ServiceError): HttpResponse {
  const status = STATUS[error.code];
  return {
    status,
    headers: { 'content-type': 'application/problem+json' },
    body: canonicalize({
      type: `urn:docedit:authority:${error.code}`,
      title: error.code,
      status,
      code: error.code,
      detail: error.message,
      ...(error.detail === undefined ? {} : { info: error.detail }),
    }),
  };
}

/** What the router needs to know about a request. */
export interface HttpRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  contentType: string;
  body: string;
}

/** The text of a body as an `open` request: JSON, or NDJSON when the content type says so. */
export function parseBody(contentType: string, body: string): Answer<{ value: unknown }> {
  try {
    if (contentType.startsWith('application/x-ndjson')) {
      const lines = body.split('\n').filter((l) => l.trim() !== '');
      const head = JSON.parse(lines[0] ?? 'null') as Record<string, unknown> | null;
      if (head === null || typeof head !== 'object' || Array.isArray(head))
        return bad('the first line must be a JSON object');
      return { ok: true, value: { ...head, commits: lines.slice(1).map((l) => JSON.parse(l)) } };
    }
    return { ok: true, value: JSON.parse(body === '' ? 'null' : body) };
  } catch {
    return bad('the body is not valid JSON');
  }
}

const bad = (message: string): Answer<never> => ({
  ok: false,
  error: { code: 'invalid_request', message },
});

/** The calls of 05 §10 that the router dispatches; `migrate` and `evaluateRules` are optional. */
export interface Routes {
  service: AuthorityService;
  /** Whether the service can serve; a service with a store to reach would check it here. */
  ready?: () => boolean;
  /** More routes under `/v1/authority/states/{stateId}/{call}`, by call name. */
  stateCalls?: Record<
    string,
    (stateId: string, body: unknown) => Promise<{ status: number; value: unknown } | ServiceError>
  >;
}

const isServiceError = (v: unknown): v is ServiceError =>
  typeof v === 'object' && v !== null && 'code' in v && 'message' in v;

/** Routes one request. Pure apart from the service it calls, so tests need no socket. */
export async function route(routes: Routes, req: HttpRequest): Promise<HttpResponse> {
  const { service } = routes;
  const { method, path } = req;
  if (path === `${API}/health` && method === 'GET') return json(200, { status: 'ok' });
  if (path === `${API}/ready` && method === 'GET') {
    const ready = routes.ready?.() ?? true;
    return json(ready ? 200 : 503, { status: ready ? 'ready' : 'not ready' });
  }
  const open = /^\/v1\/authority\/documents\/([^/]+)\/open$/.exec(path);
  if (open) {
    if (method !== 'POST') return methodNotAllowed('POST');
    const parsed = parseBody(req.contentType, req.body);
    if (!parsed.ok) return problem(parsed.error);
    const doc = decodeURIComponent(open[1]!);
    const value = parsed.value;
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      return problem(bad('the body must be a JSON object').error);
    const given = (value as Record<string, unknown>)['doc'];
    if (given !== undefined && given !== doc)
      return problem(bad('the doc in the body is not the doc in the path').error);
    const r = await service.open({ ...value, doc });
    return r.ok ? json(201, { stateId: r.stateId, seq: r.seq, doc: r.doc }) : problem(r.error);
  }
  const state = /^\/v1\/authority\/states\/([^/]+)\/([a-z-]+)$/.exec(path);
  if (state) {
    const stateId = decodeURIComponent(state[1]!);
    const call = state[2]!;
    if (call === 'content') {
      if (method !== 'GET') return methodNotAllowed('GET');
      const raw = req.query.get('seq');
      const seq = raw === null ? undefined : /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
      const r = await service.materialise(stateId, Number.isNaN(seq) ? 'x' : seq);
      if (!r.ok) return problem(r.error);
      return {
        status: 200,
        headers: {
          'content-type': JSON_TYPE,
          'x-state-id': r.stateId,
          'x-seq': String(r.seq),
          etag: `"${r.contentHash}"`,
        },
        body: r.text,
      };
    }
    const handler = routes.stateCalls?.[call];
    if (handler) {
      if (method !== 'POST') return methodNotAllowed('POST');
      const parsed = parseBody(req.contentType, req.body);
      if (!parsed.ok) return problem(parsed.error);
      const r = await handler(stateId, parsed.value);
      return isServiceError(r) ? problem(r) : json(r.status, r.value);
    }
  }
  return problem({ code: 'not_found', message: `no route for ${method} ${path}` });
}

function methodNotAllowed(allow: string): HttpResponse {
  return { ...problem({ code: 'invalid_request', message: `use ${allow}` }), status: 405 };
}

export interface ServerOptions extends Routes {
  host?: string;
  port?: number;
  /** The largest body accepted, in bytes. */
  maxBody?: number;
}

export const DEFAULT_MAX_BODY = 64 * 1024 * 1024;

async function readBody(req: IncomingMessage, max: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface RunningServer {
  server: Server;
  url: string;
  close(): Promise<void>;
}

/** Starts the binding. Port 0 picks a free port. */
export async function listen(options: ServerOptions): Promise<RunningServer> {
  const max = options.maxBody ?? DEFAULT_MAX_BODY;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      let response: HttpResponse;
      try {
        const url = new URL(req.url ?? '/', 'http://authority.invalid');
        const body = req.method === 'GET' ? '' : await readBody(req, max);
        response =
          body === null
            ? {
                ...problem({ code: 'invalid_request', message: 'the body is too large' }),
                status: 413,
              }
            : await route(options, {
                method: req.method ?? 'GET',
                path: url.pathname,
                query: url.searchParams,
                contentType: req.headers['content-type'] ?? '',
                body,
              });
      } catch (e) {
        response = {
          status: 500,
          headers: { 'content-type': 'application/problem+json' },
          body: canonicalize({
            type: 'about:blank',
            title: 'internal',
            status: 500,
            detail: String(e),
          }),
        };
      }
      res.writeHead(response.status, response.headers);
      res.end(response.body);
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve);
  });
  const { port, address } = server.address() as AddressInfo;
  return {
    server,
    url: `http://${address.includes(':') ? `[${address}]` : address}:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
        server.closeAllConnections();
      }),
  };
}
