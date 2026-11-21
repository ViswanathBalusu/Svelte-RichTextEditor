/**
 * The one request pipeline of the control plane (BE-032; 05 §6.1; 10 §3.2). In order, for every
 * request: a request identifier; the credential from `Authorization: Bearer` (cookies are never
 * read); its verification as a user token or a service credential; the route's credential rule;
 * the tenant, taken from the verified credential and nothing else (BE-011 criterion 2); the
 * browser's origin against that tenant's allow-list; only then the handler. Errors leave as
 * problem documents with a registry code and the request identifier.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  type Capability,
  type DocRole,
  type MatrixContext,
  EMPTY_PERMISSIONS,
  authorise,
  computeAccess,
  roleCaps,
} from '@docedit/authority';
import { uuid7 } from '@docedit/model';
import { DEP1, ShapeValidator, type definition } from '@docedit/protocol';
import { errorFields, redactUrl, violationSummary, type Logger } from '../log.ts';
import type { Span, VerifiedIdentity } from '../seams.ts';
import { Tracer, parseTraceparent, type TraceContext } from '../data-plane/tracing.ts';
import {
  CORS_ALLOW_HEADERS,
  CORS_EXPOSE_HEADERS,
  REQUEST_ID_HEADER,
  readJsonBody,
  sendBytes,
  sendJson,
  sendProblem,
} from './http.ts';
import {
  type IdempotencyScope,
  type IdempotencyStore,
  type StoredReply,
  REPLAY_HEADER,
  REPLAYED_HEADERS,
  fingerprintOf,
  isIdempotencyKey,
} from './idempotency.ts';
import {
  DocumentKeyDestroyedError,
  DocumentKeyUnavailableError,
} from '../storage/document-keys.ts';
import { ColdSegmentUnavailableError } from '../storage/cold-payloads.ts';
import { PayloadAbsentError } from '../storage/payload-absent.ts';
import { ApiError, isApiError, type RestCode } from './problems.ts';
import { Router, type OperationDef } from './router.ts';
import type { TenantRegistry } from './tenants.ts';
import { API_KEY_PREFIX, isOpaqueId, SERVICE_JWT_TYPE, type TokenVerifier } from './tokens.ts';
import type { UserDirectory } from './users.ts';
import { decodeJws } from './jwt.ts';

/** Who is calling: a user of the tenant, or the host backend with a service credential. */
export interface Caller {
  kind: 'user' | 'service';
  tenant: string;
  /** The verified user token; null for a service credential. */
  identity: VerifiedIdentity | null;
  /**
   * Whom changes are attributed to (BE-033 criterion 6): the user's surrogate; for a service, the
   * surrogate of the user named by `DEP-Actor`, or `system` without one.
   */
  actor: string;
  /** For logs: the kind of credential and, for a service, the key's identifier. */
  credential: string;
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  op: OperationDef;
  params: Record<string, string>;
  requestId: string;
  /**
   * The trace of the request's span (BE-087 criterion 1): a handler that opens spans passes this
   * as their parent, so its work is part of the caller's trace (the request span's identifier).
   */
  trace: TraceContext;
  caller: Caller;
  /** The request body, checked against the route's shape (PRO-040 criterion 4). */
  body(): Promise<unknown>;
}

export interface Reply {
  status: number;
  body?: unknown;
  /** Bytes to send as they are (canonical content), with their `Content-Type` in `headers`. */
  bytes?: Buffer;
  headers?: Record<string, string>;
}

export type Handler = (ctx: Ctx) => Promise<Reply>;

/** Routes outside DEP: the JWKS of minted tokens and the probes (BE-001 criterion 5). */
export type PlainHandler = (req: IncomingMessage, url: URL) => Promise<Reply>;

export interface PipelineOptions {
  tokens: TokenVerifier;
  registry: TenantRegistry;
  users: UserDirectory;
  handlers: Readonly<Record<string, Handler>>;
  plain: Readonly<Record<string, PlainHandler>>;
  /** The path of the `rest` base, for example `/v1`. */
  restPath: string;
  logger: Logger;
  /** Largest request body, bytes (a setting; ADR 0036). */
  maxBodyBytes: number;
  /** Larger limit for the routes that carry CDM content (06 §8: 16 MiB documents). */
  maxContentBodyBytes: number;
  now: () => number;
  /** Idempotency keys (05 §6.1; D140); without a store the header is ignored. */
  idempotency?: IdempotencyStore;
  /** How long a key is remembered, ms (05 §6.1: 24 hours; a setting). */
  idempotencyTtlMs?: number;
  /** How long a second request waits for the first with the same key, ms (a setting). */
  idempotencyWaitMs?: number;
  /** After how long a pending key whose request never finished may be taken over, ms. */
  idempotencyStaleMs?: number;
  /** `Retry-After` of `unavailable` problems, seconds (a setting; 05 §5.8 "back off"). */
  unavailableRetryAfterS?: number;
  /**
   * The node's shared rate limits (BE-030 criterion 2, REST half): a user over the limit gets
   * `rate_limited` with `Retry-After`. Absent: no REST limit.
   */
  rateLimits?: {
    rest(
      tenant: string,
      user: string,
      now: number,
    ): Promise<{ scope: string; retryAfterSeconds: number } | null>;
  };
  /** Prefix routes outside DEP, such as the font files (`/fonts/`); the longest prefix wins. */
  prefixes?: Readonly<Record<string, PlainHandler>>;
  /**
   * Where finished request spans go (05 §6.1; PRO-044 criterion 1). A request's `traceparent`
   * makes its span part of that trace. Absent: no spans are recorded.
   */
  onSpan?: (span: Span) => void;
}

const CONTENT_ROUTES = new Set(['createDocument', 'replaceContent']);

const DAY_MS = 24 * 60 * 60 * 1000;

/** The shape validator over the published definition (the same data as the OpenAPI schemas). */
const validator = new ShapeValidator(DEP1, { maxViolations: 32 });

function bodyViolations(shape: definition.Shape, value: unknown) {
  return validator.check(shape, value).map((v) => ({ path: v.path, rule: v.message }));
}

/** The capabilities a caller has on a document; a service credential has all of them. */
export function capabilitiesOn(caller: Caller, doc: string): ReadonlySet<Capability> | 'all' {
  if (caller.kind === 'service') return 'all';
  const role: DocRole | undefined = caller.identity!.docs[doc];
  if (role === undefined)
    throw new ApiError('forbidden', `the token does not cover document ${doc}`);
  return roleCaps(role);
}

/**
 * True when a user token does not cover `doc`. A resource named by a bare identifier in such a
 * document is answered as a missing one is, `not_found` (owner decision 57; SEC-016 criterion 4),
 * so that a refusal does not tell the caller that the identifier exists. A service credential
 * acts for the tenant and is never hidden from a document.
 */
export function hiddenFrom(caller: Caller, doc: string): boolean {
  return caller.kind === 'user' && caller.identity!.docs[doc] === undefined;
}

/** Refuses unless the caller holds `cap` on `doc` (07 §12); `forbidden` otherwise. */
export function requireCapability(caller: Caller, doc: string, cap: Capability): void {
  const caps = capabilitiesOn(caller, doc);
  if (caps !== 'all' && !caps.has(cap))
    throw new ApiError('forbidden', `${cap} on document ${doc} is needed`);
}

/**
 * The route guard: a row of the authorisation matrix of 07 §12, evaluated by the authority's
 * `authorise` (PRM-056), so that every route follows the one table. Routes the matrix has no row
 * for use the row decision D65 names. A service credential passes every row: it acts for the
 * tenant and can mint a token for anyone (D65); row 13 is enforced by the route's credentials.
 */
export function guard(
  caller: Caller,
  row: string,
  doc: string,
  extra: Omit<MatrixContext, 'credential' | 'access' | 'restrictions'> = {},
): void {
  if (caller.kind === 'service') return;
  const identity = caller.identity!;
  const role = identity.docs[doc];
  if (role === undefined)
    throw new ApiError('forbidden', `the token does not cover document ${doc}`);
  // Document-level rows depend on the role alone (07 §2); region rows would need the regions.
  const access = computeAccess({ ...identity.connection, role }, [], EMPTY_PERMISSIONS, Date.now());
  const verdict = authorise(row, {
    credential: 'user',
    access,
    restrictions: identity.restrict,
    ...extra,
  });
  if (!verdict.ok) throw new ApiError('forbidden', `${verdict.reason} (07 §12)`);
}

/** The user's role on `doc`, for a user caller; null for a service credential. */
export function roleOn(caller: Caller, doc: string): DocRole | null {
  if (caller.kind === 'service') return null;
  const role = caller.identity!.docs[doc];
  if (role === undefined)
    throw new ApiError('forbidden', `the token does not cover document ${doc}`);
  return role;
}

export class Pipeline {
  readonly #o: PipelineOptions;
  readonly #router = new Router();
  readonly #tracer: Tracer;

  constructor(opts: PipelineOptions) {
    this.#o = opts;
    this.#tracer = new Tracer(opts.onSpan, opts.now);
  }

  /** Handles one HTTP request (everything but WebSocket upgrades). */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = this.#o.now();
    const requestId = uuid7();
    res.setHeader(REQUEST_ID_HEADER, requestId);
    // PRO-044 criterion 1: the request's work is part of the trace its `traceparent` names.
    const span = this.#tracer.start('http.request', parseTraceparent(req.headers['traceparent']), {
      method: req.method ?? 'GET',
    });
    const raw = req.url ?? '/';
    const url = new URL(raw, 'http://service.invalid');
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin.toLowerCase() : null;
    const log = {
      event: 'http',
      requestId,
      method: req.method ?? 'GET',
      path: redactUrl(raw),
    };
    let route = url.pathname;
    let doc: string | undefined;
    let job: string | undefined;
    let caller: Caller | null = null;
    let cors: Record<string, string> = {};
    let status = 500;
    let code: string | undefined;
    let rules: string | undefined;
    try {
      // CORS for requests without a valid credential: some tenant must allow the origin (D66).
      if (origin && (await this.#o.registry.originRegistered(origin))) cors = corsHeaders(origin);
      if (req.method === 'OPTIONS') {
        status = await this.#preflight(req, res, url, origin);
        return;
      }
      const plain = this.#o.plain[url.pathname] ?? this.#prefix(url.pathname);
      if (plain) {
        const reply = await plain(req, url);
        status = reply.status;
        this.#send(res, reply, cors);
        return;
      }
      const base = url.pathname.startsWith(`${this.#o.restPath}/`) ? 'rest' : 'endpoint';
      const path = base === 'rest' ? url.pathname.slice(this.#o.restPath.length) : url.pathname;
      let match;
      try {
        match = this.#router.match(req.method ?? 'GET', path, base);
      } catch {
        match = null;
      }
      if (!match || match === 'method')
        throw new ApiError(
          'not_found',
          match === 'method' ? 'the route has no such method' : 'no such route',
        );
      route = base === 'rest' ? `${this.#o.restPath}${match.op.path}` : match.op.path;
      const { op, params } = match;
      doc = params['id'];
      job = params['jid'];
      if (op.security.length > 0) {
        caller = await this.#authenticate(req, op);
        // A response is readable by the browser only when the caller's tenant allows the origin.
        cors =
          origin && (await this.#o.registry.origins(caller.tenant)).includes(origin)
            ? corsHeaders(origin)
            : {};
        // BE-030 criterion 2: the user's and the tenant's buckets, shared with the sockets.
        const limited =
          caller.kind === 'user' && this.#o.rateLimits
            ? await this.#o.rateLimits.rest(caller.tenant, caller.identity!.sub, this.#o.now())
            : null;
        if (limited)
          throw new ApiError('rate_limited', `the ${limited.scope} limit is reached`, {
            retryAfterS: limited.retryAfterSeconds,
          });
      }
      const handler = this.#o.handlers[op.operationId];
      if (!handler) throw new ApiError('not_found', 'this server does not offer the route');
      let bodyRead: Promise<unknown> | null = null;
      const ctx: Ctx = {
        req,
        res,
        url,
        op,
        params,
        requestId,
        trace: { traceId: span.traceId, spanId: span.spanId },
        caller: caller ?? {
          kind: 'service',
          tenant: '',
          identity: null,
          actor: 'system',
          credential: 'none',
        },
        body: () => (bodyRead ??= this.#body(req, op)),
      };
      const reply = await this.#run(ctx, handler);
      status = reply.status;
      this.#send(res, reply, cors);
    } catch (e) {
      const err = isApiError(e)
        ? e
        : (payloadAbsentRefusal(e) ??
          coldSegmentRefusal(e, this.#o.unavailableRetryAfterS ?? 1) ??
          documentKeyRefusal(e) ??
          registryRefusal(e) ??
          infrastructureRefusal(e, this.#o.unavailableRetryAfterS ?? 1) ??
          new ApiError('internal', 'the request failed', { cause: e }));
      status = err.status;
      code = err.code;
      rules = violationSummary(err.violations);
      if (!isApiError(e))
        this.#o.logger.error({ ...log, event: 'http.error', route, ...errorFields(e) });
      if (!res.headersSent) sendProblem(res, err, requestId, cors);
      else res.destroy();
    } finally {
      span.end({ route, status, ...(code ? { code } : {}) });
      this.#o.logger.info({
        ...log,
        route,
        status,
        traceId: span.traceId,
        durationMs: this.#o.now() - started,
        ...(code ? { code } : {}),
        ...(rules ? { message: rules } : {}),
        ...(doc ? { doc } : {}),
        ...(job ? { job } : {}),
        ...(caller ? { tenant: caller.tenant, credential: caller.kind } : { credential: 'none' }),
      });
    }
  }

  #prefix(path: string): PlainHandler | undefined {
    let best: string | undefined;
    for (const p of Object.keys(this.#o.prefixes ?? {}))
      if (path.startsWith(p) && (best === undefined || p.length > best.length)) best = p;
    return best === undefined ? undefined : this.#o.prefixes![best];
  }

  /**
   * Runs the handler, through the idempotency store when the route accepts `Idempotency-Key` and
   * the request carries one (05 §6.1; D140). The claim is made before the handler runs, so of two
   * identical requests only one creates anything; the other waits for its response.
   */
  async #run(ctx: Ctx, handler: Handler): Promise<Reply> {
    const header = ctx.req.headers['idempotency-key'];
    const store = this.#o.idempotency;
    if (header === undefined || !ctx.op.idempotencyKey || !store) return handler(ctx);
    if (typeof header !== 'string' || !isIdempotencyKey(header))
      throw new ApiError(
        'validation_failed',
        'Idempotency-Key is 1 to 255 visible ASCII characters',
        {
          violations: [{ path: 'Idempotency-Key', rule: '1 to 255 characters from ! to ~ (D140)' }],
        },
      );
    const body = await ctx.body();
    const caller = ctx.caller;
    const scope: IdempotencyScope = {
      tenant: caller.tenant,
      principal: caller.kind === 'service' ? 'service' : `user:${caller.actor}`,
      route: `${ctx.req.method ?? 'GET'} ${ctx.url.pathname}`,
      key: header,
    };
    const fingerprint = fingerprintOf({
      method: ctx.req.method ?? 'GET',
      path: ctx.url.pathname,
      query: ctx.url.searchParams,
      body,
      actor: caller.kind === 'service' ? caller.actor : null,
    });
    const ttl = this.#o.idempotencyTtlMs ?? DAY_MS;
    const stale = this.#o.idempotencyStaleMs ?? 120_000;
    const wait = this.#o.idempotencyWaitMs ?? 10_000;
    const mismatch = () =>
      new ApiError(
        'idempotency_mismatch',
        'the Idempotency-Key was used for a different request (05 §6.1)',
      );
    for (let attempt = 0; attempt < 3; attempt++) {
      const claim = await store.claim(scope, fingerprint, this.#o.now(), ttl, stale);
      if (claim.claimed) {
        let reply: Reply;
        try {
          reply = await handler(ctx);
        } catch (e) {
          await store.release(scope, fingerprint).catch(() => undefined);
          throw e;
        }
        if (reply.status >= 200 && reply.status < 300)
          await store.complete(scope, fingerprint, storedReply(reply));
        else await store.release(scope, fingerprint);
        return reply;
      }
      let record = claim.record;
      if (record.fingerprint !== fingerprint) throw mismatch();
      // The first request is still running: wait for its response (criterion 5 of PRO-043).
      const deadline = this.#o.now() + wait;
      while (record.state === 'pending' && this.#o.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        const next = await store.read(scope, this.#o.now());
        if (!next) break;
        if (next.fingerprint !== fingerprint) throw mismatch();
        record = next;
      }
      if (record.state === 'done') return replayed(record.reply);
      if (this.#o.now() >= deadline)
        throw new ApiError('conflict', 'a request with this Idempotency-Key is still running', {
          retryAfterS: 1,
        });
      // The first request failed and released the key: this one may run it.
    }
    throw new ApiError('conflict', 'a request with this Idempotency-Key is still running', {
      retryAfterS: 1,
    });
  }

  #send(res: ServerResponse, reply: Reply, cors: Record<string, string>): void {
    const headers = { ...cors, ...(reply.headers ?? {}) };
    if (reply.bytes) sendBytes(res, reply.status, reply.bytes, headers);
    else if (reply.body !== undefined) sendJson(res, reply.status, reply.body, headers);
    else sendBytes(res, reply.status, null, headers);
  }

  /** 05 §6.1: allowed origins get the allowed headers; any other origin is granted nothing. */
  async #preflight(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    origin: string | null,
  ): Promise<number> {
    const allowed = origin !== null && (await this.#o.registry.originRegistered(origin));
    const base = url.pathname.startsWith(`${this.#o.restPath}/`) ? 'rest' : 'endpoint';
    const path = base === 'rest' ? url.pathname.slice(this.#o.restPath.length) : url.pathname;
    const methods = this.#router.methods(path, base);
    if (!allowed || (methods.length === 0 && !this.#o.plain[url.pathname])) {
      sendBytes(res, 403, null, {});
      return 403;
    }
    sendBytes(res, 204, null, {
      ...corsHeaders(origin!),
      'Access-Control-Allow-Methods': [...new Set(methods.length ? methods : ['GET'])].join(', '),
      'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS.join(', '),
    });
    return 204;
  }

  async #authenticate(req: IncomingMessage, op: OperationDef): Promise<Caller> {
    const header = req.headers.authorization;
    // Bearer only (05 §3.1; 10 §3.2): a cookie is never read for authentication.
    if (typeof header !== 'string' || !/^Bearer [^\s]+$/.test(header))
      throw new ApiError('unauthenticated', 'a bearer token is required', { challenge: 'Bearer' });
    const credential = header.slice(7);
    const service = isServiceCredential(credential);
    if (service && !op.security.includes('service'))
      throw new ApiError('forbidden', 'the route takes a user token');
    if (!service && !op.security.includes('user'))
      throw new ApiError('forbidden', 'the route takes a service credential');
    if (!service) {
      const identity = await this.#o.tokens.verifyUser(credential);
      // DEP-Actor is a service credential's header; with a user token it is ignored (BE-033).
      return {
        kind: 'user',
        tenant: identity.tenant,
        identity,
        actor: identity.connection.sub,
        credential: 'user',
      };
    }
    const s = await this.#o.tokens.verifyService(credential);
    const actorHeader = req.headers['dep-actor'];
    let actor = 'system';
    if (actorHeader !== undefined) {
      if (typeof actorHeader !== 'string' || !isOpaqueId(actorHeader))
        throw new ApiError('validation_failed', 'DEP-Actor names a user by their sub', {
          violations: [{ path: 'DEP-Actor', rule: 'an opaque user identifier' }],
        });
      actor = (await this.#o.users.resolve(s.tenant, actorHeader)).surrogate;
    }
    return { kind: 'service', tenant: s.tenant, identity: null, actor, credential: s.credential };
  }

  async #body(req: IncomingMessage, op: OperationDef): Promise<unknown> {
    const limit = CONTENT_ROUTES.has(op.operationId)
      ? this.#o.maxContentBodyBytes
      : this.#o.maxBodyBytes;
    const body = await readJsonBody(req, limit);
    if (!op.body) return body;
    if (body === undefined)
      throw new ApiError('validation_failed', 'the route needs a body', {
        violations: [{ path: '', rule: 'a JSON body' }],
      });
    const violations = bodyViolations(op.body, body);
    if (violations.length)
      throw new ApiError('validation_failed', 'the body does not match the published schema', {
        violations,
      });
    return body;
  }
}

const REST_CODES: ReadonlySet<string> = new Set(
  DEP1.errors.filter((e) => e.surfaces.includes('rest')).map((e) => e.code),
);

/**
 * An error of another part (the data plane's `readContent`, a store) that carries a registry code
 * of the REST surface becomes that problem; its message is not passed on, since it may quote input.
 */
/**
 * A read that needs the payload of a commit that is in no store (thinned, or replaced by a
 * tombstone; HIS-040 criterion 2, HIS-032 criterion 4) is `not_found` with a message that the
 * detail was removed. It never returns content built without the commit. A payload that moved to a
 * cold segment is not such a commit: the log store reads it from the segment (HIS-029).
 */
function payloadAbsentRefusal(e: unknown): ApiError | null {
  if (!(e instanceof PayloadAbsentError)) return null;
  return new ApiError(
    'not_found',
    `the detail of commit ${e.seq} was removed and is no longer available (08 §11, §13)`,
    { cause: e },
  );
}

/**
 * A read that needs a payload from a cold segment that cannot be read (HIS-029 criterion 5): the
 * object is missing or cannot be decoded, or a payload in it does not match the hash the chain
 * covers. It is `unavailable` with a `Retry-After`, and nothing is served in its place. Reads that
 * need no cold payload, and live editing, are not affected.
 */
function coldSegmentRefusal(e: unknown, retryAfterS: number): ApiError | null {
  if (!(e instanceof ColdSegmentUnavailableError)) return null;
  return new ApiError(
    'unavailable',
    e.seq === undefined
      ? 'a part of the history of this document cannot be read now (08 §11)'
      : `the detail of commit ${e.seq} cannot be read now (08 §11)`,
    { retryAfterS, cause: e },
  );
}

/**
 * A read that needs a document's own key (HIS-041): a destroyed key is `not_found`, with the reason,
 * since the content is gone for good; a key service that cannot be reached is `unavailable`, so the
 * document is not served and never served unsealed (criterion 3). The messages carry no key data.
 */
function documentKeyRefusal(e: unknown): ApiError | null {
  if (e instanceof DocumentKeyDestroyedError)
    return new ApiError(
      'not_found',
      'the key of this document was destroyed, so its content is unreadable (08 §13)',
      { cause: e },
    );
  if (e instanceof DocumentKeyUnavailableError)
    return new ApiError('unavailable', 'the key of this document is not available now', {
      cause: e,
    });
  return null;
}

function registryRefusal(e: unknown): ApiError | null {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code !== 'string' || !REST_CODES.has(code) || code === 'internal') return null;
  return new ApiError(code as RestCode, `the request was refused (${code})`, { cause: e });
}

/** A reply as the idempotency store keeps it: the replayed headers and the body bytes. */
function storedReply(reply: Reply): StoredReply {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(reply.headers ?? {}))
    if (REPLAYED_HEADERS.includes(k.toLowerCase())) headers[k] = v;
  if (reply.bytes) return { status: reply.status, headers, body: reply.bytes.toString('base64') };
  if (reply.body === undefined) return { status: reply.status, headers };
  headers['Content-Type'] ??= 'application/json';
  return {
    status: reply.status,
    headers,
    body: Buffer.from(JSON.stringify(reply.body), 'utf8').toString('base64'),
  };
}

function replayed(stored: StoredReply): Reply {
  const headers = { ...stored.headers, [REPLAY_HEADER]: 'true' };
  return stored.body === undefined
    ? { status: stored.status, headers }
    : { status: stored.status, bytes: Buffer.from(stored.body, 'base64'), headers };
}

/** Node.js socket errors that mean a dependency could not be reached. */
const NET_ERRORS = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/**
 * A dependency that is down or overloaded (PostgreSQL, object storage) is `unavailable` with a
 * `Retry-After`, never `internal`: a client backs off and tries again (05 §5.8; 06 §8 "PostgreSQL
 * unavailable"; PRO-039, the server half). SQLSTATE classes: 08 connection exceptions, 53
 * insufficient resources, 57P01 to 57P03 shutdowns, 40001 and 40P01 serialisation failures and
 * deadlocks, 55P03 lock not available.
 */
export function infrastructureRefusal(e: unknown, retryAfterS: number): ApiError | null {
  const x = e as { code?: unknown; status?: unknown; name?: unknown; message?: unknown } | null;
  if (!x || typeof x !== 'object') return null;
  const code = typeof x.code === 'string' ? x.code : '';
  const sqlstate = /^[0-9A-Z]{5}$/.test(code) ? code : '';
  const unavailable =
    NET_ERRORS.has(code) ||
    sqlstate.startsWith('08') ||
    sqlstate.startsWith('53') ||
    ['57P01', '57P02', '57P03', '40001', '40P01', '55P03'].includes(sqlstate) ||
    (x.name === 'ObjectStoreError' &&
      typeof x.status === 'number' &&
      (x.status === 0 || x.status >= 500)) ||
    (typeof x.message === 'string' &&
      /^(Connection terminated|timeout exceeded when trying to connect)/.test(x.message));
  return unavailable
    ? new ApiError('unavailable', 'a dependency of the service is unavailable; try again later', {
        retryAfterS,
        cause: e,
      })
    : null;
}

/** Whether a bearer credential is a service credential: an API key or a `dep-svc+jwt`. */
export function isServiceCredential(credential: string): boolean {
  if (credential.startsWith(API_KEY_PREFIX)) return true;
  try {
    return decodeJws(credential).header['typ'] === SERVICE_JWT_TYPE;
  } catch {
    return false;
  }
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Expose-Headers': CORS_EXPOSE_HEADERS.join(', '),
    Vary: 'Origin',
  };
}
