/**
 * A relay as a DEP server, for the kit's own tests (PRO-124 criteria 2 and 3; SYN-044 criterion 5).
 * It is the smallest server that speaks DEP in `mode: "relay"` (05 §9; 04 §14): the `Relay` of
 * `@docedit/authority` behind discovery, a two-route control plane and the real-time plane, on a
 * loopback port. It is a test target, not a product.
 *
 * What it does: discovery with `mode: "relay"` and none of `regions`, `suggest-enforced` or
 * `fields`; `POST /tokens` and `POST /documents` with the service credential (05 §11, the
 * bootstrap contract); `hello` and `welcome`; `ch.open` with a stream of the stored commits the
 * client lacks; `sync.submit` into `Relay.submit`; `sync.commit` to the other channels of the
 * document. It stores each commit before it acknowledges it, in memory.
 *
 * What it does not do, because a relay has no document model: it reads no content (a document is
 * created empty whatever `content` the request names, and `GET /documents/{id}/content` is a route
 * this server does not offer); it enforces no role, region or invariant (the `access` it sends is
 * the role's capabilities and nothing is checked against it); it has no presence, heartbeat or
 * token-expiry timers; it chunks no frame (a frame over the limit closes with 4413).
 */
import { generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  Relay,
  relayCapabilities,
  type Connection,
  type RelayOut,
  type StoredCommit,
} from '@docedit/authority';
import { formatTimestamp, uuid7 } from '@docedit/model';
import {
  DEP1,
  depCodec,
  utf8Length,
  type Access,
  type ClientMessage,
  type DocRole,
  type Limits,
} from '@docedit/protocol';
import { toAck, toReject, toRemoteCommit } from '@docedit/protocol/bridge';
import { WebSocketServer, type WebSocket } from 'ws';
import { KIT_ORIGIN, type StartedTarget } from './reference.ts';

const codec = depCodec();
const STATUS = new Map(DEP1.errors.map((e) => [e.code, e.httpStatus ?? 500]));
const ROLES: readonly DocRole[] = ['viewer', 'commenter', 'suggester', 'editor', 'owner', 'filler'];

/** What a relay announces beyond `mode` (05 §9): it announces none of the features of a document model. */
const ANNOUNCED = relayCapabilities([]);

const LIMITS: Limits = {
  maxMessageBytes: 131_072,
  maxCommitBytes: 1_048_576,
  maxStepsPerCommit: 500,
  maxRebaseSteps: 5000,
  maxChannels: 16,
  heartbeatMs: 25_000,
  ackTimeoutMs: 15_000,
  presenceHz: 10,
  presenceBytes: 1024,
  catchUpCommits: 5000,
  catchUpBytes: 5 * 1024 * 1024,
};

/** Capabilities by role, as `access` shows them. A relay checks none of them (04 §14). */
const CAPS: Record<DocRole, Access['caps']> = {
  viewer: ['view'],
  commenter: ['view', 'comment'],
  suggester: ['view', 'comment', 'suggest'],
  editor: ['view', 'comment', 'suggest', 'edit'],
  owner: ['view', 'comment', 'suggest', 'edit', 'structure', 'manage'],
  filler: ['view', 'fill'],
};

class Problem extends Error {
  readonly code: string;
  readonly extra: Record<string, unknown>;
  constructor(code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

interface Grant {
  sub: string;
  name?: string;
  docs: Record<string, DocRole>;
  exp: number;
}

/** One document of the relay: its ordering and its log. */
interface Stream {
  id: string;
  createdAt: number;
  incarnation: string;
  log: StoredCommit[];
  relay: Relay;
  /** The open channels, by the key the relay knows them by. */
  channels: Map<string, Open>;
}

interface Open {
  key: string;
  session: Session;
  ch: number;
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

export interface RelayTargetOptions {
  /** Test of the profile's failure path: the store refuses every commit, so none is acknowledged. */
  failStore?: boolean;
  /** Test of the profile's failure path: the base is replaced by the head, so no commit is stale. */
  ignoreBase?: boolean;
}

export async function startRelay(opts: RelayTargetOptions = {}): Promise<StartedTarget> {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const kid = randomUUID();
  const credential = `tck-relay-${randomBytes(18).toString('base64url')}`;
  const tenant = randomUUID();
  const streams = new Map<string, Stream>();
  const tokens = new Map<string, Grant>();
  const sessions = new Set<Session>();

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  function createStream(): Stream {
    const log: StoredCommit[] = [];
    const stream: Stream = {
      id: uuid7(),
      createdAt: Date.now(),
      incarnation: uuid7(),
      log,
      relay: new Relay({
        now: () => Date.now(),
        store: {
          append: (c) => {
            if (opts.failStore) return false;
            log.push(c);
            return true;
          },
        },
      }),
      channels: new Map(),
    };
    streams.set(stream.id, stream);
    return stream;
  }

  function mint(body: Record<string, unknown>): { token: string; expiresAt: string } {
    const sub = body['sub'];
    const docs = body['docs'];
    if (typeof sub !== 'string' || !sub || typeof docs !== 'object' || docs === null)
      throw new Problem('validation_failed', 'sub and docs are required', {
        violations: [{ path: '/sub', rule: 'a string' }],
      });
    const entries = Object.entries(docs as Record<string, unknown>);
    if (
      !entries.length ||
      entries.length > 20 ||
      entries.some(([, r]) => !ROLES.includes(r as DocRole))
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
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + expiresIn;
    const header = { alg: 'ES256', typ: 'JWT', kid };
    const payload = {
      iss: origin,
      aud: origin,
      iat,
      exp,
      jti: uuid7(),
      tid: tenant,
      sub,
      docs,
      ...(typeof body['name'] === 'string' ? { name: body['name'] } : {}),
    };
    const input = `${b64(header)}.${b64(payload)}`;
    const sig = sign('sha256', Buffer.from(input), {
      key: privateKey as KeyObject,
      dsaEncoding: 'ieee-p1363',
    });
    const jwt = `${input}.${sig.toString('base64url')}`;
    tokens.set(jwt, {
      sub,
      ...(typeof body['name'] === 'string' ? { name: body['name'] } : {}),
      docs: Object.fromEntries(entries) as Record<string, DocRole>,
      exp: exp * 1000,
    });
    return { token: jwt, expiresAt: formatTimestamp(exp * 1000) };
  }

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
          features: [...ANNOUNCED.features],
          mode: ANNOUNCED.mode,
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
    const authorization = req.headers.authorization;
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer '))
      throw new Problem('unauthenticated', 'a bearer token is required');
    const cred = authorization.slice(7);
    if (cred !== credential && !tokens.has(cred))
      throw new Problem('unauthenticated', 'the token is not valid');
    const service = cred === credential;
    const parts = path.slice(4).split('/').map(decodeURIComponent);
    const needService = () => {
      if (!service) throw new Problem('forbidden', 'the route takes a service credential');
    };
    if (parts.length === 1 && parts[0] === 'tokens' && method === 'POST') {
      needService();
      return {
        status: 200,
        body: mint((body ?? {}) as Record<string, unknown>),
        headers: { 'cache-control': 'no-store' },
      };
    }
    if (parts.length === 1 && parts[0] === 'documents' && method === 'POST') {
      needService();
      // A relay has no document model: the content of the request is not read or kept.
      const s = createStream();
      return {
        status: 201,
        body: {
          id: s.id,
          externalId: null,
          title: null,
          properties: {},
          classification: null,
          state: 'active',
          cdm: 1,
          requires: [],
          createdAt: formatTimestamp(s.createdAt),
        },
      };
    }
    throw new Problem('not_found', 'this relay does not offer the route (05 §9)');
  }

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const requestId = uuid7();
    const url = new URL(req.url ?? '/', origin);
    const send = (
      status: number,
      body: unknown,
      headers: Record<string, string> = {},
      type = 'application/json',
    ) => {
      res.writeHead(status, {
        'dep-request-id': requestId,
        ...(body === undefined ? {} : { 'content-type': type }),
        ...headers,
      });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        try {
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
          const p = e instanceof Problem ? e : new Problem('internal', String(e));
          const status = STATUS.get(p.code) ?? 500;
          send(
            status,
            {
              type: 'about:blank',
              title: p.code,
              status,
              code: p.code,
              detail: p.message,
              requestId,
              ...p.extra,
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
        tokens,
        streams,
        ignoreBase: opts.ignoreBase ?? false,
        ended: (x) => sessions.delete(x),
      });
      sessions.add(s);
    });
  });

  return {
    name: 'relay (test target)',
    discovery: `${origin}/.well-known/dep`,
    credential,
    origin: KIT_ORIGIN,
    testMode: false,
    logs: () => '',
    stop: async () => {
      for (const s of sessions) s.end(1001, 'stopping');
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

interface SessionDeps {
  tokens: Map<string, Grant>;
  streams: Map<string, Stream>;
  ignoreBase: boolean;
  ended: (s: Session) => void;
}

/** The server side of one socket. */
class Session {
  private readonly ws: WebSocket;
  private readonly origin: string | undefined;
  private readonly deps: SessionDeps;
  private grant: Grant | null = null;
  private id = '';
  private readonly channels = new Map<number, Open & { stream: Stream }>();
  private chain: Promise<void> = Promise.resolve();
  private helloTimer: ReturnType<typeof setTimeout>;
  private done = false;

  constructor(ws: WebSocket, origin: string | undefined, deps: SessionDeps) {
    this.ws = ws;
    this.origin = origin;
    this.deps = deps;
    ws.on('message', (data, binary) => {
      const text = Buffer.isBuffer(data)
        ? data.toString('utf8')
        : Buffer.concat(data as Buffer[]).toString('utf8');
      this.chain = this.chain
        .then(() => this.receive(text, binary))
        .catch(() => this.fatal(undefined, 'internal', 'the server failed', 4500));
    });
    ws.on('close', () => this.finish());
    this.helloTimer = setTimeout(
      () => !this.grant && this.end(4408, 'hello not received in time'),
      10_000,
    );
  }

  send(m: Record<string, unknown>): void {
    if (this.done) return;
    const text = codec.encode(m, { validate: false });
    this.ws.send(text);
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

  private fatal(re: string | undefined, code: string, message: string, close: number): void {
    this.send({
      t: 'error',
      ...(re !== undefined ? { re } : {}),
      d: { code, message, retryable: false, fatal: true },
    });
    this.end(close, message);
  }

  private async receive(text: string, binary: boolean): Promise<void> {
    if (this.done) return;
    if (binary)
      return this.fatal(undefined, 'bad_message', 'pm-steps/1 uses no binary frames', 4400);
    if (utf8Length(text) > LIMITS.maxMessageBytes)
      return this.fatal(undefined, 'too_large', 'the frame is too large', 4413);
    const r = codec.decode(text, { receiver: 'server' });
    if (r.kind === 'invalid') {
      this.send(r.reply as unknown as Record<string, unknown>);
      if (r.fatal || !this.grant) this.end(r.close ?? 4400, r.reason);
      return;
    }
    if (r.kind === 'unknown') {
      if (!this.grant)
        return this.fatal(undefined, 'bad_message', 'the first message must be hello', 4400);
      if (r.reply) this.send(r.reply as unknown as Record<string, unknown>);
      return;
    }
    const m = r.message as ClientMessage;
    if (!this.grant && m.t !== 'hello')
      return this.fatal(undefined, 'bad_message', 'the first message must be hello', 4400);
    switch (m.t) {
      case 'hello':
        return this.hello(m.id, m.d);
      case 'ping':
        return this.send(m.id !== undefined ? { t: 'pong', re: m.id } : { t: 'pong' });
      case 'ch.open':
        return this.open(m.id, m.ch, m.d);
      case 'ch.close':
        return this.closeChannel(m.ch);
      case 'sync.submit':
        return this.submit(m.id, m.ch, m.d);
      default:
        return;
    }
  }

  private hello(id: string, d: Extract<ClientMessage, { t: 'hello' }>['d']): void {
    if (this.grant) {
      this.send({
        t: 'error',
        re: id,
        d: { code: 'bad_message', message: 'hello was sent twice', retryable: false, fatal: false },
      });
      return;
    }
    if (!d.versions.includes('1.0'))
      return this.fatal(id, 'unsupported_version', 'no common version', 4406);
    const grant = this.deps.tokens.get(d.token);
    if (!grant) return this.fatal(id, 'unauthenticated', 'the token is not valid', 4401);
    if (grant.exp <= Date.now()) return this.fatal(id, 'token_expired', 'the token expired', 4401);
    if (this.origin !== undefined && this.origin !== KIT_ORIGIN)
      return this.fatal(id, 'forbidden', 'the origin is not allowed', 4403);
    clearTimeout(this.helloTimer);
    this.grant = grant;
    this.id = uuid7();
    this.send({
      t: 'welcome',
      re: id,
      d: {
        version: '1.0',
        session: this.id,
        user: { id: grant.sub, ...(grant.name !== undefined ? { name: grant.name } : {}) },
        features: [...ANNOUNCED.features],
        limits: LIMITS,
        tokenExp: formatTimestamp(grant.exp),
      },
    });
  }

  private open(id: string, ch: number, d: Extract<ClientMessage, { t: 'ch.open' }>['d']): void {
    const grant = this.grant!;
    const reject = (code: string, message: string) =>
      this.send({ t: 'ch.rejected', re: id, ch, d: { code, message } });
    if (d.engine !== 'pm-steps/1') return reject('unsupported_engine', 'pm-steps/1 only');
    if (d.cdm !== 1) return reject('unsupported_cdm', 'CDM 1 only');
    const unannounced = d.features.filter((f) => !ANNOUNCED.features.includes(f));
    if (unannounced.length)
      return reject('unsupported_feature', `not announced: ${unannounced.join(', ')}`);
    const role = grant.docs[d.doc];
    if (role === undefined) return reject('forbidden', 'the token does not cover this document');
    const stream = this.deps.streams.get(d.doc);
    if (!stream) return reject('not_found', `no document ${d.doc}`);
    if ([...this.channels.values()].some((o) => o.stream === stream))
      return reject('already_open', 'one channel per document (05 §4)');
    if (this.channels.size >= LIMITS.maxChannels)
      return reject('channel_limit', 'maxChannels reached');

    const head = stream.relay.headSeq;
    // A client that resumes at this incarnation and a seq the log has gets the commits it lacks. A
    // client with another incarnation, or a seq beyond the head, cannot be served by a relay, which
    // keeps no content: it is told to reload. Without `resume` the client starts from the first
    // commit.
    const resume = d.resume;
    const known = resume === undefined ? true : resume.incarnation === stream.incarnation;
    const from = resume === undefined ? 0 : resume.seq;
    const reload = !known || from > head;
    const key = `${this.id}:${ch}`;
    const access: Access = {
      rev: 1,
      asOfSeq: head,
      docRole: role,
      caps: CAPS[role],
      scopes: { doc: CAPS[role], body: CAPS[role], defs: CAPS[role] },
      leases: {},
      fill: null,
      restrictions: [],
    };
    this.send({
      t: 'ch.opened',
      re: id,
      ch,
      d: {
        head,
        incarnation: stream.incarnation,
        catchUp: reload ? 'reload' : 'stream',
        access,
      },
    });
    if (!reload && from < head) {
      this.send({
        t: 'sync.commit',
        ch,
        d: { commits: stream.log.slice(from).map((c) => toRemoteCommit(c, 0)) },
      });
      this.send({ t: 'sync.caughtUp', ch, d: { seq: head } });
    }
    const conn: Connection = {
      sub: grant.sub,
      session: this.id,
      role,
      groups: [],
      participantRoles: [],
      participantActive: false,
    };
    // The channel is registered in the same turn as the replay above, so no commit falls between.
    stream.relay.open(key, conn);
    const open = { key, session: this, ch, stream };
    stream.channels.set(key, open);
    this.channels.set(ch, open);
  }

  private closeChannel(ch: number): void {
    const o = this.channels.get(ch);
    if (!o) return;
    this.channels.delete(ch);
    o.stream.relay.close(o.key);
    o.stream.channels.delete(o.key);
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
    const input = this.deps.ignoreBase ? { ...d, base: o.stream.relay.headSeq } : d;
    const outs: RelayOut[] = o.stream.relay.submit(o.key, input);
    for (const out of outs) {
      const target = o.stream.channels.get(out.channel);
      if (!target) continue;
      const m = out.msg;
      if (m.t === 'sync.ack')
        target.session.send({ t: 'sync.ack', re: id, ch: target.ch, d: toAck(m, 0) });
      else if (m.t === 'sync.reject')
        target.session.send({ t: 'sync.reject', re: id, ch: target.ch, d: toReject(m, 0) });
      else if (m.t === 'sync.commit')
        target.session.send({
          t: 'sync.commit',
          ch: target.ch,
          d: { commits: [toRemoteCommit(m.commit, 0)] },
        });
    }
  }

  private finish(): void {
    if (this.done) return;
    this.done = true;
    clearTimeout(this.helloTimer);
    for (const ch of [...this.channels.keys()]) this.closeChannel(ch);
    this.deps.ended(this);
  }
}
