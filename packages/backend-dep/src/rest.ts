/**
 * The control plane over `fetch` (05 §6): JSON bodies, `Authorization: Bearer` (05 §3.1: tokens
 * are never placed in URLs), `If-Match` and `Idempotency-Key` where a route takes them, and RFC
 * 9457 problems turned into a PortError carrying the problem's registry `code`.
 *
 * Responses are validated against the definition's shapes, which never reject unknown members
 * (05 §1 rule 3; PRO-005).
 */
import {
  DEP1_WIRE,
  PortError,
  ShapeValidator,
  definition,
  type ErrorCode,
} from '@docedit/protocol';
import type { Platform, ResponseLike } from './platform.ts';

const validator = new ShapeValidator(DEP1_WIRE);
const CODES: ReadonlySet<string> = new Set(definition.ERROR_CODES);
const AUTH: ReadonlySet<string> = new Set(['unauthenticated', 'token_expired', 'revoked']);

export interface RestResult<T> {
  value: T;
  /** The `ETag` response header (05 §6.1), or null. */
  etag: string | null;
  status: number;
}

export interface RestRequest {
  query?: Readonly<Record<string, string | number | undefined>>;
  body?: unknown;
  ifMatch?: string;
  idempotencyKey?: string;
  /** The named shape of the response body, checked before it is returned. */
  shape?: string;
  /** The response is a cursor list `{ items, nextCursor }` of `shape` (05 §6.1). */
  list?: boolean;
}

export interface RestAuth {
  /** The token to present. */
  token(): Promise<string>;
  /** A new token after the server refused one (05 §5.8: "after a new token"); rejects when the source fails. */
  renew(code: ErrorCode): Promise<string>;
}

/** Error code for a response without a usable problem document. */
function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
    case 422:
      return 'validation_failed';
    case 401:
      return 'unauthenticated';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 412:
    case 428:
      return 'precondition_failed';
    case 413:
      return 'too_large';
    case 429:
      return 'rate_limited';
    case 503:
      return 'unavailable';
    default:
      return 'internal';
  }
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Builds `path?query`, encoding every value; undefined members are left out. */
export function withQuery(
  path: string,
  query: Readonly<Record<string, string | number | undefined>> = {},
): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query))
    if (v !== undefined) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `${path}?${parts.join('&')}` : path;
}

export class RestClient {
  /** The complete REST base URL from discovery (05 §2); paths are appended to it, never resolved against it. */
  readonly base: string;
  private readonly p: Platform;
  private readonly auth: RestAuth;

  constructor(base: string, p: Platform, auth: RestAuth) {
    this.base = base.replace(/\/+$/, '');
    this.p = p;
    this.auth = auth;
  }

  async call<T>(method: string, path: string, req: RestRequest = {}): Promise<RestResult<T>> {
    const url = this.base + withQuery(path, req.query);
    let token = await this.auth.token();
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
      };
      if (req.body !== undefined) headers['content-type'] = 'application/json';
      if (req.ifMatch !== undefined) headers['if-match'] = req.ifMatch;
      if (req.idempotencyKey !== undefined) headers['idempotency-key'] = req.idempotencyKey;
      let res: ResponseLike;
      try {
        res = await this.p.fetch(
          url,
          req.body === undefined
            ? { method, headers }
            : { method, headers, body: JSON.stringify(req.body) },
        );
      } catch (e) {
        throw new PortError('unavailable', `${method} ${path} failed: ${messageOf(e)}`);
      }
      if (res.status >= 200 && res.status < 300) return this.success<T>(res, path, req);
      const error = await problemOf(res, `${method} ${path}`);
      if (attempt === 0 && AUTH.has(error.code)) {
        // A refused token is renewed once (05 §5.8); the token source raises the auth event.
        token = await this.auth.renew(error.code);
        continue;
      }
      throw error;
    }
  }

  /** Reads every page of a cursor list (05 §6.1). */
  async all<T>(path: string, req: RestRequest = {}): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10_000; page++) {
      const query = cursor === undefined ? req.query : { ...req.query, cursor };
      const r = await this.call<{ items: T[]; nextCursor: string | null }>(
        'GET',
        path,
        query === undefined ? { ...req, list: true } : { ...req, query, list: true },
      );
      out.push(...r.value.items);
      if (r.value.nextCursor === null || r.value.nextCursor === undefined) return out;
      cursor = r.value.nextCursor;
    }
    throw new PortError('internal', `${path}: too many pages`);
  }

  private async success<T>(
    res: ResponseLike,
    path: string,
    req: RestRequest,
  ): Promise<RestResult<T>> {
    const etag = res.headers.get('etag');
    const text = res.status === 204 ? '' : await res.text();
    if (text === '') return { value: undefined as T, etag, status: res.status };
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new PortError('internal', `${path}: the response is not JSON`);
    }
    if (req.shape) {
      const items =
        req.list && value && typeof value === 'object' && 'items' in value
          ? (value as { items: unknown }).items
          : undefined;
      const problems = req.list
        ? Array.isArray(items)
          ? items.flatMap((x, i) =>
              validator.checkNamed(req.shape!, x).map((v) => `/items/${i}${v.path} ${v.message}`),
            )
          : ['/items is not an array']
        : validator.checkNamed(req.shape, value).map((v) => `${v.path} ${v.message}`);
      if (problems.length)
        throw new PortError(
          'internal',
          `${path}: the response does not match ${req.shape}: ${problems.slice(0, 4).join('; ')}`,
        );
    }
    return { value: value as T, etag, status: res.status };
  }
}

/** The PortError for an error response: the problem's registry code, or one for the status. */
export async function problemOf(res: ResponseLike, what: string): Promise<PortError> {
  let problem: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(await res.text()) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      problem = parsed as Record<string, unknown>;
  } catch {
    problem = null;
  }
  const code =
    typeof problem?.['code'] === 'string' && CODES.has(problem['code'])
      ? (problem['code'] as ErrorCode)
      : codeForStatus(res.status);
  const detail =
    typeof problem?.['detail'] === 'string'
      ? problem['detail']
      : typeof problem?.['title'] === 'string'
        ? problem['title']
        : `${what} answered ${res.status}`;
  const retry = res.headers.get('retry-after');
  const seconds = retry !== null && /^\d+$/.test(retry) ? Number(retry) : undefined;
  return new PortError(code, detail, {
    ...(seconds !== undefined ? { retryAfterMs: seconds * 1000 } : {}),
    ...(problem ? { details: problem } : {}),
  });
}
