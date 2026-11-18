/**
 * The mock backend as a DEP server, for the kit's own tests (PRO-099; FRW-067 criterion 2): the
 * in-memory service of `@docedit/backend-mock`, which runs the real authority, behind discovery,
 * the control plane of the bootstrap contract and the real-time plane, on a loopback port. Each
 * socket gets a MockBackend as its server-side session and every frame goes through the protocol's
 * codec. It is a test target, not a product: what the mock does not model (export jobs, the commits
 * resource, idempotency beyond creation) is answered as a route this server does not offer. The
 * routes of the service credential (07 §12 row 13) refuse a user token with `forbidden` first,
 * whether or not the mock serves them: that refusal needs no model of the resource.
 *
 * With `testMode`, timers are short (heartbeat 1 s, no clock skew on expiry), as the test-mode
 * switch of 05 §11 would make them (PRO-109; ADR 0042).
 */
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  type KeyObject,
} from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MATRIX } from '@docedit/authority';
import { MockBackend, MockService, type MockToken } from '@docedit/backend-mock';
import { formatTimestamp, uuid7, type CdmEnvelope } from '@docedit/model';
import {
  DEP1,
  PortError,
  Reassembler,
  chunkMessage,
  depCodec,
  isPortError,
  isSyncReject,
  utf8Length,
  type ClientMessage,
  type DocRole,
  type SyncChannel,
  type Unsubscribe,
} from '@docedit/protocol';
import { WebSocketServer, type WebSocket } from 'ws';
import type { StartedTarget } from './reference.ts';
import { KIT_ORIGIN } from './reference.ts';

const codec = depCodec();
const STATUS = new Map(DEP1.errors.map((e) => [e.code, e.httpStatus ?? 500]));
const ROLES = ['viewer', 'commenter', 'suggester', 'editor', 'owner', 'filler'];
const CHANNEL_REJECT = new Set([
  'not_found',
  'forbidden',
  'unsupported_engine',
  'unsupported_cdm',
  'unsupported_feature',
  'channel_limit',
  'already_open',
  'unavailable',
]);
/** The routes that take the service credential, from the published matrix (07 §12 row 13). */
const SERVICE_ROUTES = (MATRIX.find((r) => r.id === 'service')?.routes ?? []).map((r) => {
  const [method = '', template = ''] = r.split(' ');
  return { method, path: new RegExp(`^${template.replace(/\{[^}]+\}/g, '[^/]+')}$`) };
});

export interface MockTargetOptions {
  presence?: boolean;
  testMode?: boolean;
  /**
   * Test of the fuzzer's failure path (PRO-116 criterion 4): after this many pings have been
   * answered, every further ping is ignored, so the server stalls. Unset, the server never stalls.
   */
  stallAfterPings?: number;
  /**
   * Test of the kit's close-code check (PRO-037 criterion 4): after `hello`, a message of one of
   * these unknown types makes the server close with the code given, or drop the connection without
   * a close frame (`'drop'`). Unset, the server closes only as 05 §5.7 says.
   */
  closeOnUnknown?: Readonly<Record<string, number | 'drop'>>;
  /**
   * Test of the kit's CORS scenarios (PRO-041 criterion 5): a server that leaves one header out of
   * `Access-Control-Allow-Headers` or `Access-Control-Expose-Headers`, or that grants every origin
   * by echoing it or with `*`. Unset, the server answers as 05 §6.1 says.
   */
  cors?: { withoutAllowed?: string; withoutExposed?: string; anyOrigin?: 'echo' | 'star' };
}

class Problem extends Error {
  readonly code: string;
  readonly extra: Record<string, unknown>;
  constructor(code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

interface DocMeta {
  id: string;
  externalId: string | null;
  title: string | null;
  properties: Record<string, unknown>;
  classification: string | null;
  state: 'active' | 'locked' | 'archived';
  rev: number;
  deleted: boolean;
  createdAt: number;
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

export async function startMock(opts: MockTargetOptions = {}): Promise<StartedTarget> {
  const testMode = opts.testMode ?? false;
  const service = new MockService({
    presence: opts.presence ?? true,
    ...(testMode ? { limits: { heartbeatMs: 1000 } } : {}),
  });
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const kid = randomUUID();
  const credential = `tck-mock-${randomBytes(18).toString('base64url')}`;
  const tenant = randomUUID();
  const docs = new Map<string, DocMeta>();
  const order: string[] = [];
  const tokens = new Map<string, MockToken>();
  const idempotency = new Map<string, { hash: string; status: number; body: unknown }>();
  const docWatermarks = new Map<string, number>();
  const sessions = new Set<Session>();
  const stall =
    opts.stallAfterPings === undefined ? null : { answered: 0, after: opts.stallAfterPings };
  let serial = 0;

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const serviceId = origin;

  const covers = (t: MockToken, doc: string) =>
    t.docs[doc] !== undefined && t.serial > (docWatermarks.get(`${t.sub}\u0000${doc}`) ?? 0);

  /** One page of a list (05 §6.1; D14, D72): `limit` of 1 to 200, and an opaque offset cursor. */
  function page<T>(url: URL, all: readonly T[]): { items: T[]; nextCursor: string | null } {
    const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new Problem('validation_failed', 'limit is 1 to 200 (D72)', {
        violations: [{ path: 'limit', rule: '1 to 200' }],
      });
    let start = 0;
    const cursor = url.searchParams.get('cursor');
    if (cursor !== null) {
      const text = Buffer.from(cursor, 'base64url').toString('utf8');
      const n = Number(text.replace(/^o:/, ''));
      if (!text.startsWith('o:') || !Number.isInteger(n))
        throw new Problem('validation_failed', 'an unknown cursor (D72)', {
          violations: [{ path: 'cursor', rule: 'a cursor of this server' }],
        });
      start = n;
    }
    return {
      items: all.slice(start, start + limit),
      nextCursor:
        start + limit < all.length ? Buffer.from(`o:${start + limit}`).toString('base64url') : null,
    };
  }

  function mint(body: Record<string, unknown>): { token: string; expiresAt: string } {
    const sub = body['sub'];
    const d = body['docs'];
    if (typeof sub !== 'string' || !sub || typeof d !== 'object' || d === null)
      throw new Problem('validation_failed', 'sub and docs are required', {
        violations: [{ path: '/sub', rule: 'a string' }],
      });
    const entries = Object.entries(d as Record<string, unknown>);
    if (
      !entries.length ||
      entries.length > 20 ||
      entries.some(([, r]) => !ROLES.includes(r as string))
    )
      throw new Problem('validation_failed', 'docs names 1 to 20 documents with a role', {
        violations: [{ path: '/docs', rule: '1 to 20 entries' }],
      });
    const expiresIn = body['expiresIn'] ?? 900;
    if (
      typeof expiresIn !== 'number' ||
      !Number.isInteger(expiresIn) ||
      expiresIn < 1 ||
      expiresIn > 900
    )
      throw new Problem('validation_failed', 'expiresIn is 1 to 900 seconds', {
        violations: [{ path: '/expiresIn', rule: '1 to 900' }],
      });
    const user = {
      sub,
      ...(typeof body['name'] === 'string' ? { name: body['name'] } : {}),
      groups: Array.isArray(body['grp']) ? (body['grp'] as string[]) : [],
    };
    const t = service.mintToken(user, Object.fromEntries(entries) as Record<string, DocRole>);
    // NumericDate has whole seconds: the expiry is the same instant in the token and in expiresAt.
    t.exp = Math.floor((t.iat + expiresIn * 1000) / 1000) * 1000;
    serial = t.serial;
    const header = { alg: 'ES256', typ: 'JWT', kid };
    const payload = {
      iss: serviceId,
      aud: serviceId,
      iat: Math.floor(t.iat / 1000),
      exp: Math.floor(t.exp / 1000),
      jti: t.jti,
      tid: tenant,
      sub,
      docs: t.docs,
      ...(user.name ? { name: user.name } : {}),
      ...(user.groups.length ? { grp: user.groups } : {}),
      ...(Array.isArray(body['restrict']) ? { restrict: body['restrict'] } : {}),
    };
    const input = `${b64(header)}.${b64(payload)}`;
    const sig = sign('sha256', Buffer.from(input), {
      key: privateKey as KeyObject,
      dsaEncoding: 'ieee-p1363',
    });
    const jwt = `${input}.${sig.toString('base64url')}`;
    tokens.set(jwt, t);
    return { token: jwt, expiresAt: formatTimestamp(t.exp) };
  }

  /** The caller of a request: the service, a user token, or a problem. */
  function caller(req: IncomingMessage): { kind: 'service' } | { kind: 'user'; token: MockToken } {
    const h = req.headers.authorization;
    if (typeof h !== 'string' || !h.startsWith('Bearer '))
      throw new Problem('unauthenticated', 'a bearer token is required');
    const cred = h.slice(7);
    if (cred === credential) return { kind: 'service' };
    const t = tokens.get(cred);
    if (!t) throw new Problem('unauthenticated', 'the token is not valid');
    const v = service.verify(t);
    if (v !== 'ok') throw new Problem(v, `the token was refused: ${v}`);
    return { kind: 'user', token: t };
  }

  function docMeta(id: string): DocMeta {
    const m = docs.get(id);
    if (!m || m.deleted) throw new Problem('not_found', `no document ${id}`);
    return m;
  }

  function role(c: ReturnType<typeof caller>, doc: string): DocRole | 'service' {
    if (c.kind === 'service') return 'service';
    if (!covers(c.token, doc))
      throw new Problem('forbidden', 'the token does not cover this document (05 §6.1)');
    return c.token.docs[doc]!;
  }

  const manage = (r: DocRole | 'service') => {
    if (r !== 'service' && r !== 'owner')
      throw new Problem('forbidden', 'manage is required (07 §12)');
  };
  const resource = (m: DocMeta) => ({
    id: m.id,
    externalId: m.externalId,
    title: m.title,
    properties: m.properties,
    classification: m.classification,
    state: m.state,
    cdm: 1,
    requires: [],
    createdAt: formatTimestamp(m.createdAt),
  });

  async function route(
    req: IncomingMessage,
    url: URL,
    body: unknown,
  ): Promise<{ status: number; body?: unknown; headers?: Record<string, string> }> {
    const method = req.method ?? 'GET';
    const path = url.pathname;
    if (path === '/.well-known/dep' && method === 'GET')
      return {
        status: 200,
        body: {
          versions: ['1.0'],
          ws: `${origin.replace('http', 'ws')}/dep`,
          rest: `${origin}/v1`,
          engines: ['pm-steps/1'],
          cdm: { min: 1, max: 1 },
          features: [...service.features],
          mode: 'authority',
          jwks_uri: `${origin}/.well-known/jwks.json`,
        },
      };
    if (path === '/.well-known/jwks.json')
      return {
        status: 200,
        body: {
          keys: [
            { ...(publicKey.export({ format: 'jwk' }) as object), kid, alg: 'ES256', use: 'sig' },
          ],
        },
      };
    if (!path.startsWith('/v1/')) throw new Problem('not_found', 'no such route');
    const parts = path.slice(4).split('/').map(decodeURIComponent);
    const c = caller(req);
    // A service credential names the actor by an opaque identifier in DEP-Actor: 1 to 255
    // characters, no whitespace, no control characters (05 §3.2; UX-096). The mock does not act as
    // that user; it only refuses a header that is not an identifier, as the protocol requires.
    const actor = req.headers['dep-actor'];
    if (
      c.kind === 'service' &&
      actor !== undefined &&
      (typeof actor !== 'string' || !/^[^\s\p{Cc}]{1,255}$/u.test(actor))
    )
      throw new Problem('validation_failed', 'DEP-Actor names a user by an opaque identifier');
    const svc = () => {
      if (c.kind !== 'service')
        throw new Problem('forbidden', 'the route takes a service credential');
    };
    const sub = path.slice(3);
    if (SERVICE_ROUTES.some((r) => r.method === method && r.path.test(sub))) svc();
    const ifMatch = req.headers['if-match'];
    if (parts[0] === 'tokens' && method === 'POST') {
      svc();
      return {
        status: 200,
        body: mint(body as Record<string, unknown>),
        headers: { 'cache-control': 'no-store' },
      };
    }
    if (parts[0] === 'sessions' && parts[1] === 'revoke' && method === 'POST') {
      svc();
      const b = body as { sub?: string; doc?: string };
      if (typeof b?.sub !== 'string')
        throw new Problem('validation_failed', 'sub is required', {
          violations: [{ path: '/sub', rule: 'a string' }],
        });
      if (b.doc === undefined) service.revokeSessions(b.sub);
      else {
        docWatermarks.set(`${b.sub}\u0000${b.doc}`, serial);
        for (const s of sessions) s.revokedFor(b.sub, b.doc);
      }
      return { status: 204 };
    }
    if (parts[0] !== 'documents')
      throw new Problem('not_found', 'this server does not offer the route');
    if (parts.length === 1) {
      svc();
      if (method === 'POST') {
        const b = (body ?? {}) as Record<string, unknown>;
        const key = req.headers['idempotency-key'];
        const hash = createHash('sha256').update(JSON.stringify(b)).digest('hex');
        if (typeof key === 'string') {
          const seen = idempotency.get(key);
          if (seen && seen.hash !== hash)
            throw new Problem('idempotency_mismatch', 'the key was used with another body');
          if (seen) return { status: seen.status, body: seen.body };
        }
        if (
          b['content'] !== undefined &&
          (typeof b['content'] !== 'object' || b['content'] === null)
        )
          throw new Problem('validation_failed', 'content is a CDM envelope', {
            violations: [{ path: '/content', rule: 'an object' }],
          });
        if (b['title'] !== undefined && typeof b['title'] !== 'string')
          throw new Problem('validation_failed', 'title is a string', {
            violations: [{ path: '/title', rule: 'a string' }],
          });
        const externalId = typeof b['externalId'] === 'string' ? b['externalId'] : null;
        if (externalId && [...docs.values()].some((d) => d.externalId === externalId && !d.deleted))
          throw new Problem('conflict', 'the externalId is in use (D62)');
        const content =
          (b['content'] as CdmEnvelope | undefined) ??
          (await import('@docedit/protocol/contract')).contractDocument();
        const id = service.createDocument(content);
        const meta: DocMeta = {
          id,
          externalId,
          title: (b['title'] as string) ?? null,
          properties: (b['properties'] as Record<string, unknown>) ?? {},
          classification: null,
          state: 'active',
          rev: 1,
          deleted: false,
          createdAt: Date.now(),
        };
        docs.set(id, meta);
        order.push(id);
        const out = { status: 201, body: resource(meta) };
        if (typeof key === 'string') idempotency.set(key, { hash, ...out });
        return out;
      }
      if (method === 'GET') {
        const ext = url.searchParams.get('externalId');
        const all = order
          .map((id) => docs.get(id)!)
          .filter((d) => !d.deleted && (ext === null || d.externalId === ext));
        const p = page(url, all);
        return { status: 200, body: { items: p.items.map(resource), nextCursor: p.nextCursor } };
      }
      throw new Problem('not_found', 'the route has no such method');
    }
    const id = parts[1]!;
    const meta = docMeta(id);
    const r = role(c, id);
    const doc = service.document(id)!;
    const rest = parts.slice(2).join('/');
    const etag = `"m${meta.rev}"`;
    const needMatch = (current: string) => {
      if (typeof ifMatch !== 'string')
        throw new Problem('precondition_failed', 'If-Match is required', { status: 428 });
      if (ifMatch !== '*' && ifMatch !== current)
        throw new Problem('precondition_failed', 'the resource changed since the ETag was read');
    };
    if (rest === '' && method === 'GET')
      return { status: 200, body: resource(meta), headers: { etag } };
    if (rest === '' && method === 'PATCH') {
      manage(r);
      needMatch(etag);
      const b = (body ?? {}) as Record<string, unknown>;
      if (b['title'] !== undefined) meta.title = b['title'] as string;
      if (b['properties'] !== undefined)
        meta.properties = b['properties'] as Record<string, unknown>;
      if (typeof b['state'] === 'string' && b['state'] !== meta.state) {
        meta.state = b['state'] as DocMeta['state'];
        service.setDocumentState(id, meta.state);
      }
      meta.rev++;
      return { status: 200, body: resource(meta), headers: { etag: `"m${meta.rev}"` } };
    }
    if (rest === '' && method === 'DELETE') {
      manage(r);
      meta.deleted = true;
      return { status: 204 };
    }
    if (rest === 'content' && method === 'GET') {
      const seq = url.searchParams.get('seq');
      const content = doc.content(seq === null ? undefined : Number(seq));
      return {
        status: 200,
        body: content,
        headers: { etag: `"${content.incarnation}:${content.seq}"` },
      };
    }
    if (rest === 'content' && method === 'PUT') {
      svc();
      needMatch(`"${doc.content().incarnation}:${doc.content().seq}"`);
      service.replaceContent(id, body as CdmEnvelope);
      return { status: 204 };
    }
    if (rest === 'regions' && method === 'GET')
      return { status: 200, body: page(url, doc.regions()) };
    // Fields (12 §10; FRW-067 criterion 2): the mock derives them from the document it runs.
    if (rest === 'fields' && method === 'GET')
      return { status: 200, body: page(url, doc.fieldList()) };
    if (rest === 'field-values' && method === 'GET') {
      const seq = url.searchParams.get('seq');
      const read = doc.fieldValues(
        seq === null ? undefined : Number(seq),
        url.searchParams.getAll('key'),
      );
      return {
        status: 200,
        body: { values: read.value.values, seq: read.value.seq },
        headers: { etag: read.etag },
      };
    }
    if (rest === 'field-values' && method === 'PATCH') {
      manage(r);
      needMatch(doc.fieldValues().etag);
      const values = (body as { values?: Record<string, unknown> } | undefined)?.values;
      if (typeof values !== 'object' || values === null)
        throw new Problem('validation_failed', 'values is an object of values by key', {
          violations: [{ path: '/values', rule: 'an object' }],
        });
      const out = doc.prefill(values, '*');
      return {
        status: 200,
        body: { values: out.value.values, seq: doc.head },
        headers: { etag: out.etag },
      };
    }
    if (rest === 'grants' && method === 'GET') {
      manage(r);
      const g = doc.grants();
      return { status: 200, body: g.value, headers: { etag: g.etag } };
    }
    if (rest === 'grants' && method === 'PATCH') {
      manage(r);
      if (typeof ifMatch !== 'string')
        throw new Problem('precondition_failed', 'If-Match is required', { status: 428 });
      const g = doc.updateGrants(body as never, ifMatch === '*' ? doc.grants().etag : ifMatch);
      return { status: 200, body: g.value, headers: { etag: g.etag } };
    }
    if (parts[2] === 'regions' && parts[4] === 'state' && method === 'PUT') {
      manage(r);
      if (typeof ifMatch !== 'string')
        throw new Problem('precondition_failed', 'If-Match is required', { status: 428 });
      const s = doc.setRegionState(parts[3]!, (body as { state: never }).state);
      return { status: 200, body: s.value, headers: { etag: s.etag } };
    }
    throw new Problem('not_found', 'this server does not offer the route');
  }

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const requestId = uuid7();
    const url = new URL(req.url ?? '/', origin);
    const reqOrigin = req.headers.origin;
    const without = (list: string, name: string | undefined) =>
      list
        .split(', ')
        .filter((h) => h.toLowerCase() !== name?.toLowerCase())
        .join(', ');
    const granted =
      reqOrigin === KIT_ORIGIN || (reqOrigin !== undefined && opts.cors?.anyOrigin !== undefined);
    const cors: Record<string, string> = granted
      ? {
          'access-control-allow-origin': opts.cors?.anyOrigin === 'star' ? '*' : reqOrigin!,
          'access-control-expose-headers': without(
            'ETag, Retry-After, Deprecation, Sunset, DEP-Request-Id',
            opts.cors?.withoutExposed,
          ),
          vary: 'Origin',
        }
      : {};
    const send = (
      status: number,
      body: unknown,
      headers: Record<string, string> = {},
      type = 'application/json',
    ) => {
      res.writeHead(status, {
        'dep-request-id': requestId,
        ...cors,
        ...(body === undefined ? {} : { 'content-type': type }),
        ...headers,
      });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') {
      if (!granted) return send(403, undefined);
      return send(204, undefined, {
        'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE',
        'access-control-allow-headers': without(
          'Authorization, Content-Type, If-Match, Idempotency-Key, DEP-Actor, traceparent',
          opts.cors?.withoutAllowed,
        ),
      });
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= 16 * 1024 * 1024) chunks.push(c);
    });
    req.on('end', () => {
      void (async () => {
        try {
          if (size > 16 * 1024 * 1024) throw new Problem('too_large', 'the body is too large');
          const text = Buffer.concat(chunks).toString('utf8');
          let body: unknown;
          if (text) {
            try {
              body = JSON.parse(text);
            } catch {
              throw new Problem('validation_failed', 'the body is not JSON', {
                violations: [{ path: '', rule: 'JSON' }],
              });
            }
          }
          const out = await route(req, url, body);
          send(out.status, out.body, out.headers);
        } catch (e) {
          const p =
            e instanceof Problem
              ? e
              : isPortError(e)
                ? new Problem(e.code, e.message, e.details ?? {})
                : new Problem('internal', String(e));
          const status = (p.extra['status'] as number | undefined) ?? STATUS.get(p.code) ?? 500;
          const { status: _s, ...extra } = p.extra;
          send(
            status,
            {
              type: 'about:blank',
              title: p.code,
              status,
              code: p.code,
              detail: p.message,
              requestId,
              ...extra,
            },
            {},
            'application/problem+json',
          );
        }
      })();
    });
  });

  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (p) => (p.has('dep.v1') ? 'dep.v1' : false),
  });
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', origin).pathname !== '/dep') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const s = new Session(ws, req.headers.origin, {
        service,
        tokens,
        covers,
        testMode,
        features: service.features,
        ended: (x) => sessions.delete(x),
        stall,
        closeOnUnknown: opts.closeOnUnknown ?? {},
      });
      sessions.add(s);
    });
  });

  return {
    name: testMode ? 'mock backend (test mode)' : 'mock backend',
    discovery: `${origin}/.well-known/dep`,
    credential,
    origin: KIT_ORIGIN,
    testMode,
    logs: () => '',
    stop: async () => {
      for (const s of sessions) s.end(1001, 'stopping');
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await service.dispose();
    },
  };
}

interface SessionDeps {
  service: MockService;
  tokens: Map<string, MockToken>;
  covers: (t: MockToken, doc: string) => boolean;
  testMode: boolean;
  features: readonly string[];
  ended: (s: Session) => void;
  stall: { answered: number; after: number } | null;
  closeOnUnknown: Readonly<Record<string, number | 'drop'>>;
}

interface Open {
  doc: string;
  channel: SyncChannel;
  offs: Unsubscribe[];
}

/** The server side of one socket. */
class Session {
  private readonly ws: WebSocket;
  private readonly origin: string | undefined;
  private readonly deps: SessionDeps;
  private backend: MockBackend | null = null;
  private token: MockToken | null = null;
  private readonly channels = new Map<number, Open>();
  private readonly reassembler = new Reassembler();
  private chain: Promise<void> = Promise.resolve();
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  private heard = Date.now();
  private spoke = Date.now();
  private done = false;

  constructor(ws: WebSocket, origin: string | undefined, deps: SessionDeps) {
    this.ws = ws;
    this.origin = origin;
    this.deps = deps;
    ws.on('message', (data, binary) => {
      this.heard = Date.now();
      const text = Buffer.isBuffer(data)
        ? data.toString('utf8')
        : Buffer.concat(data as Buffer[]).toString('utf8');
      this.chain = this.chain
        .then(() => this.receive(text, binary))
        .catch(() => this.fatal(undefined, 'internal', 'the server failed', 4500));
    });
    ws.on('close', () => this.finish());
    this.timers.push(
      setTimeout(() => !this.backend && this.end(4408, 'hello not received in time'), 10_000),
    );
  }

  private limits() {
    return this.deps.service.limits;
  }

  private send(m: Record<string, unknown>): void {
    if (this.done) return;
    const text = codec.encode(m, { validate: false });
    this.spoke = Date.now();
    if (utf8Length(text) <= this.limits().maxMessageBytes) this.ws.send(text);
    else
      for (const f of chunkMessage(text, this.limits().maxMessageBytes, uuid7())) this.ws.send(f);
  }

  end(code: number, reason: string): void {
    if (this.done) return;
    try {
      this.ws.close(code, reason);
    } catch {
      this.ws.terminate();
    }
    this.finish();
  }

  private fatal(
    re: string | undefined,
    code: string,
    message: string,
    close: number,
    extra: Record<string, unknown> = {},
  ): void {
    this.send({
      t: 'error',
      ...(re !== undefined ? { re } : {}),
      d: { code, message, retryable: false, fatal: true, ...extra },
    });
    this.end(close, message);
  }

  private async receive(text: string, binary: boolean): Promise<void> {
    if (this.done) return;
    if (binary)
      return this.fatal(undefined, 'bad_message', 'pm-steps/1 uses no binary frames', 4400);
    if (utf8Length(text) > this.limits().maxMessageBytes)
      return this.fatal(undefined, 'too_large', 'the frame is too large', 4413);
    return this.message(text);
  }

  private async message(text: string): Promise<void> {
    const r = codec.decode(text, { receiver: 'server' });
    if (r.kind === 'invalid') {
      this.send(r.reply as unknown as Record<string, unknown>);
      if (r.fatal || !this.backend) this.end(r.close ?? 4400, r.reason);
      return;
    }
    if (r.kind === 'unknown') {
      if (!this.backend)
        return this.fatal(undefined, 'bad_message', 'the first message must be hello', 4400);
      const how = Object.hasOwn(this.deps.closeOnUnknown, r.t)
        ? this.deps.closeOnUnknown[r.t]
        : undefined;
      if (how === 'drop') {
        this.ws.terminate();
        return this.finish();
      }
      if (how !== undefined) return this.end(how, 'closed on request of the test');
      if (r.reply) this.send(r.reply as unknown as Record<string, unknown>);
      return;
    }
    const m = r.message as ClientMessage;
    if (!this.backend && m.t !== 'hello')
      return this.fatal(undefined, 'bad_message', 'the first message must be hello', 4400);
    switch (m.t) {
      case 'hello':
        return this.hello(m.id, m.d);
      case 'ping': {
        const stall = this.deps.stall;
        if (stall && stall.answered++ >= stall.after) return;
        return this.send(m.id !== undefined ? { t: 'pong', re: m.id } : { t: 'pong' });
      }
      case 'chunk': {
        const c = this.reassembler.push(m.d, Date.now());
        if (c.status === 'error') return this.fatal(undefined, 'bad_message', c.reason, 4400);
        if (c.status === 'complete') return this.message(c.text);
        return;
      }
      case 'auth.refresh':
        return this.refresh(m.id, m.d.token);
      case 'ch.open':
        return this.open(m.id, m.ch, m.d);
      case 'ch.close':
        return this.closeChannel(m.ch);
      case 'sync.submit':
        return this.submit(m.id, m.ch, m.d);
      case 'presence.update': {
        const o = this.channels.get(m.ch);
        if (o) this.backend!.presence?.update(o.doc, m.d);
        return;
      }
      default:
        return;
    }
  }

  private async hello(id: string, d: Extract<ClientMessage, { t: 'hello' }>['d']): Promise<void> {
    if (this.backend) {
      this.send({
        t: 'error',
        re: id,
        d: { code: 'bad_message', message: 'hello was sent twice', retryable: false, fatal: false },
      });
      return;
    }
    if (!d.versions.includes('1.0'))
      return this.fatal(id, 'unsupported_version', 'no common protocol version', 4406, {
        versions: ['1.0'],
      });
    const token = this.deps.tokens.get(d.token);
    if (!token) return this.fatal(id, 'unauthenticated', 'the token is not valid', 4401);
    const verdict = this.deps.service.verify(token);
    if (verdict !== 'ok') return this.fatal(id, verdict, `the token was refused: ${verdict}`, 4401);
    if (this.origin !== undefined && this.origin !== KIT_ORIGIN)
      return this.fatal(id, 'forbidden', 'the origin is not allowed', 4403);
    this.token = token;
    const backend = new MockBackend(this.deps.service, async () => this.token!, {
      features: d.features,
    });
    await backend.connect();
    this.backend = backend;
    backend.auth.onRevoked((e) => {
      this.send({ t: 'auth.revoked', d: { reason: e.reason } });
      this.end(4401, 'revoked');
    });
    const s = backend.auth.session!;
    this.send({
      t: 'welcome',
      re: id,
      d: {
        version: '1.0',
        session: s.session,
        user: s.user,
        features: [...this.deps.features],
        limits: s.limits,
        tokenExp: s.tokenExp,
      },
    });
    this.arm();
    const hb = this.limits().heartbeatMs;
    const beat = setInterval(
      () => {
        if (Date.now() - this.heard > 2 * hb)
          this.end(1000, 'nothing heard for two heartbeat intervals');
        else if (Date.now() - this.spoke >= hb) this.send({ t: 'ping' });
      },
      Math.max(200, Math.floor(hb / 4)),
    );
    this.timers.push(beat as unknown as ReturnType<typeof setTimeout>);
  }

  /** `auth.expiring` about 60 s before expiry, and the close at expiry (05 §5.1). */
  private arm(): void {
    const left = this.token!.exp - this.deps.service.now();
    this.timers.push(
      setTimeout(
        () =>
          this.send({
            t: 'auth.expiring',
            d: { inMs: Math.max(0, this.token!.exp - this.deps.service.now()) },
          }),
        Math.max(0, left - 60_000),
      ),
    );
    const grace = this.deps.testMode ? 0 : 60_000;
    this.timers.push(
      setTimeout(
        () => this.fatal(undefined, 'token_expired', 'the token expired', 4401),
        Math.min(left + grace, 2 ** 31 - 1),
      ),
    );
  }

  private async refresh(id: string, raw: string): Promise<void> {
    const t = this.deps.tokens.get(raw);
    if (!t || t.sub !== this.token?.sub || this.deps.service.verify(t) !== 'ok') {
      this.send({
        t: 'error',
        re: id,
        d: {
          code: 'unauthenticated',
          message: 'the token is not valid for this session',
          retryable: false,
          fatal: false,
        },
      });
      return;
    }
    this.token = t;
    const r = await this.backend!.auth.refresh();
    this.send({ t: 'auth.ok', re: id, d: { tokenExp: r.tokenExp } });
  }

  private async open(
    id: string,
    ch: number,
    d: Extract<ClientMessage, { t: 'ch.open' }>['d'],
  ): Promise<void> {
    const reject = (code: string, message: string) =>
      this.send({
        t: 'ch.rejected',
        re: id,
        ch,
        d: { code: CHANNEL_REJECT.has(code) ? code : 'unavailable', message },
      });
    if (d.engine !== 'pm-steps/1') return reject('unsupported_engine', 'pm-steps/1 only');
    if (d.cdm !== 1) return reject('unsupported_cdm', 'CDM 1 only');
    const unannounced = d.features.filter((f) => !this.deps.features.includes(f));
    if (unannounced.length)
      return reject('unsupported_feature', `not announced: ${unannounced.join(', ')}`);
    if ([...this.channels.values()].some((o) => o.doc === d.doc))
      return reject('already_open', 'one channel per document (05 §4)');
    if (this.channels.size >= this.limits().maxChannels)
      return reject('channel_limit', 'maxChannels reached');
    // A channel token (05 §3.1): same user as the session; the channel then runs on a backend of its own.
    let backend = this.backend!;
    let token = this.token!;
    if (d.token !== undefined) {
      const own = this.deps.tokens.get(d.token);
      if (!own || own.sub !== this.token!.sub || this.deps.service.verify(own) !== 'ok')
        return reject('forbidden', 'a channel token must be valid and carry the session user');
      token = own;
      backend = new MockBackend(this.deps.service, async () => own, { features: d.features });
      await backend.connect();
    }
    if (!this.deps.covers(token, d.doc))
      return reject('forbidden', 'the token does not cover this document');
    // 03 §11: a client that lacks a feature the document requires is refused.
    const requires = this.deps.service.document(d.doc)?.content().requires ?? [];
    const lacking = requires.filter((f) => !d.features.includes(f));
    if (lacking.length)
      return reject('unsupported_feature', `the document requires ${lacking.join(', ')}`);
    let channel: SyncChannel;
    try {
      channel = await backend.sync.open(d.doc, d.resume ? { resume: d.resume } : {});
    } catch (e) {
      return reject(isPortError(e) ? e.code : 'unavailable', String(e));
    }
    const open: Open = {
      doc: d.doc,
      channel,
      offs: backend === this.backend ? [] : [() => void backend.close()],
    };
    this.channels.set(ch, open);
    this.send({ t: 'ch.opened', re: id, ch, d: channel.opened });
    let firstAccess = true;
    let firstState = true;
    open.offs.push(
      channel.onCommits((commits) => this.send({ t: 'sync.commit', ch, d: { commits } })),
      channel.onReset((r) => this.send({ t: 'sync.reset', ch, d: r })),
      channel.onAccess((a) =>
        firstAccess ? (firstAccess = false) : this.send({ t: 'perm.changed', ch, d: a }),
      ),
      channel.onEvent((e) => this.send({ t: 'event', ch, d: e })),
      channel.onCheck((c) => this.send({ t: 'sync.check', ch, d: c })),
      channel.onState((s) => {
        if (firstState) return void (firstState = false);
        if (s.status === 'live') this.send({ t: 'sync.caughtUp', ch, d: { seq: s.seq } });
        else if (s.status === 'closed' && s.code !== null) {
          this.channels.delete(ch);
          this.send({ t: 'ch.closed', ch, d: { code: s.code, reason: s.reason } });
        }
      }),
    );
    const presence = backend.presence;
    if (presence)
      open.offs.push(
        presence.onPeers(d.doc, (p) => {
          if (this.channels.get(ch) === open) this.send({ t: 'presence.state', ch, d: p });
        }),
      );
  }

  /** A revocation for one document (D73): its channel closes with `forbidden`. */
  revokedFor(sub: string, doc: string): void {
    if (this.token?.sub !== sub) return;
    for (const [ch, o] of this.channels)
      if (o.doc === doc) {
        this.closeChannel(ch);
        this.send({
          t: 'ch.closed',
          ch,
          d: { code: 'forbidden', reason: 'the host revoked access to this document' },
        });
      }
  }

  private closeChannel(ch: number): void {
    const o = this.channels.get(ch);
    if (!o) return;
    this.channels.delete(ch);
    for (const off of o.offs) off();
    o.channel.close();
  }

  private submit(
    id: string,
    ch: number,
    d: Extract<ClientMessage, { t: 'sync.submit' }>['d'],
  ): void {
    const o = this.channels.get(ch);
    if (!o)
      return this.send({
        t: 'error',
        re: id,
        ch,
        d: { code: 'unavailable', message: 'no such channel', retryable: true, fatal: false },
      });
    o.channel.submit(d).then(
      (ack) => this.channels.get(ch) === o && this.send({ t: 'sync.ack', re: id, ch, d: ack }),
      (e: unknown) => {
        if (this.channels.get(ch) !== o) return;
        if (isSyncReject(e)) this.send({ t: 'sync.reject', re: id, ch, d: e.toJSON() });
        else if (e instanceof PortError)
          this.send({
            t: 'error',
            re: id,
            ch,
            d: { code: 'bad_message', message: e.message, retryable: false, fatal: false },
          });
      },
    );
  }

  private finish(): void {
    if (this.done) return;
    this.done = true;
    for (const t of this.timers) clearTimeout(t);
    for (const ch of [...this.channels.keys()]) this.closeChannel(ch);
    void this.backend?.close();
    this.deps.ended(this);
  }
}
