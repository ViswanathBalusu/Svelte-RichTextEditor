/**
 * A DEP server for backend-dep's tests, built on backend-mock: the in-memory service, which runs
 * the real authority (`Room`), behind the wire protocol (05 §2, §4 to §6). Each socket gets a
 * MockBackend as its server-side session, and frames go through the protocol's codec. It is the
 * "port to wire" direction of backend-mock's translation, so that backend-dep can be tested end to
 * end before the document service's data plane exists. Universal, like backend-mock.
 */
import {
  MockBackend,
  MockService,
  type MockServiceOptions,
  type MockToken,
  type MockUser,
} from '@docedit/backend-mock';
import {
  PortError,
  definition,
  depCodec,
  isPortError,
  isSyncReject,
  type ClientMessage,
  type DocRole,
  type ErrorCode,
  type ServerMessage,
  type SyncChannel,
  type Unsubscribe,
} from '@docedit/protocol';
import type { HttpRequest, HttpResponse, MemoryServer, ServerSocket } from './memory-network.ts';

const codec = depCodec();
const STATUS = new Map(definition.ERRORS.map((e) => [e.code, e.httpStatus ?? 500]));
const CHANNEL_REJECT = new Set(definition.CHANNEL_REJECT_CODES);

export interface MockDepServerOptions extends MockServiceOptions {
  /** The origin of the URLs in discovery (default `https://dep.test`). */
  origin?: string;
  /** Changes the discovery document, for tests of discovery and negotiation. */
  discovery?: (d: Record<string, unknown>) => Record<string, unknown>;
  /** Changes the `welcome` payload, for tests of negotiation. */
  welcome?: (d: Record<string, unknown>) => Record<string, unknown>;
  /**
   * A view token for content reads and `ch.opened` (ADR 0019; D28, D70), as a projecting gateway
   * would set it. backend-mock serves the full view and sets none.
   */
  view?: () => string | undefined;
}

/** The problem details response of 05 §6.1 for an error. */
function problem(
  code: ErrorCode,
  detail: string,
  extra: Record<string, string> = {},
): HttpResponse {
  const status = STATUS.get(code) ?? 500;
  return {
    status,
    headers: { 'content-type': 'application/problem+json', ...extra },
    body: JSON.stringify({ type: 'about:blank', title: code, status, code, detail }),
  };
}

const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): HttpResponse => ({
  status,
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

export class MockDepServer implements MemoryServer {
  readonly service: MockService;
  readonly origin: string;
  /** Every session opened, for tests that look at the server side. */
  readonly sessions: WireSession[] = [];
  private readonly tokens = new Map<string, MockToken>();
  private readonly opts: MockDepServerOptions;

  constructor(opts: MockDepServerOptions = {}) {
    this.opts = opts;
    this.service = new MockService(opts);
    this.origin = opts.origin ?? 'https://dep.test';
  }

  /**
   * The features this server announces: the service's, without `comments`. The service has the
   * comments port in process (ADR 0417), but this REST emulation has no thread routes, so it does not
   * offer the feature and a kit run against it skips the `comments` profile.
   */
  private features(): string[] {
    return this.service.features.filter((f) => f !== 'comments');
  }

  get endpoint(): string {
    return this.origin;
  }

  discovery(): Record<string, unknown> {
    const d = {
      versions: ['1.0'],
      ws: `${this.origin.replace(/^http/, 'ws')}/dep`,
      rest: `${this.origin}/v1`,
      engines: ['pm-steps/1'],
      cdm: { min: 1, max: 1 },
      features: this.features(),
      mode: 'authority',
      jwks_uri: `${this.origin}/.well-known/jwks.json`,
    };
    return this.opts.discovery ? this.opts.discovery(d) : d;
  }

  /** `POST /tokens` in effect: a new token string for a user (05 §3.1). */
  mintToken(user: MockUser, docs: Readonly<Record<string, DocRole>>): string {
    const t = this.service.mintToken(user, docs);
    const s = `tok.${t.jti}.${t.sub}`;
    this.tokens.set(s, t);
    return s;
  }

  token(s: string): MockToken | undefined {
    return this.tokens.get(s);
  }

  welcomePayload(d: Record<string, unknown>): Record<string, unknown> {
    return this.opts.welcome ? this.opts.welcome(d) : d;
  }

  /** The features `welcome` announces: the service's, as the test's `welcome` option changes them. */
  announcedFeatures(): readonly string[] {
    const d = this.welcomePayload({ features: this.features() });
    return (d['features'] as string[] | undefined) ?? [];
  }

  /** The view token to send, if the test set one. */
  view(): string | undefined {
    return this.opts.view?.();
  }

  accept(socket: ServerSocket): string | null {
    if (!socket.protocols.includes('dep.v1')) return null;
    this.sessions.push(new WireSession(this, socket));
    return 'dep.v1';
  }

  async http(req: HttpRequest): Promise<HttpResponse> {
    const url = new URL(req.url);
    if (url.pathname === '/.well-known/dep' && req.method === 'GET')
      return json(200, this.discovery());
    if (!url.pathname.startsWith('/v1/')) return problem('not_found', `no route ${url.pathname}`);
    const auth = req.headers['authorization'] ?? '';
    const token = auth.startsWith('Bearer ') ? this.tokens.get(auth.slice(7)) : undefined;
    if (!token) return problem('unauthenticated', 'no valid bearer token');
    const verdict = this.service.verify(token);
    if (verdict !== 'ok') return problem(verdict, `the token was refused: ${verdict}`);
    const parts = url.pathname.slice('/v1/'.length).split('/');
    if (parts[0] !== 'documents' || parts[1] === undefined)
      return problem('not_found', `no route ${url.pathname}`);
    const docId = decodeURIComponent(parts[1]);
    const role = token.docs[docId];
    if (!role) return problem('forbidden', 'the token does not cover this document (05 §6.1)');
    const doc = this.service.document(docId);
    if (!doc) return problem('not_found', `no document ${docId}`);
    const route = `${req.method} ${parts.slice(2).join('/')}`;
    const ifMatch = req.headers['if-match'];
    try {
      if (route === 'GET content') {
        const seq = url.searchParams.get('seq');
        const c = doc.content(seq === null ? undefined : Number(seq));
        const view = this.view();
        return json(200, view === undefined ? c : { ...c, view }, {
          etag: `"${c.incarnation}:${c.seq}"`,
        });
      }
      if (route === 'GET regions') return json(200, { items: doc.regions(), nextCursor: null });
      if (route === 'GET grants') {
        const g = doc.grants();
        return json(200, g.value, { etag: g.etag });
      }
      if (route === 'PATCH grants' || (parts[2] === 'regions' && parts[4] === 'state')) {
        if (ifMatch === undefined) return problem('precondition_failed', 'If-Match is required');
        if (role !== 'owner') return problem('forbidden', 'manage is required (07 §12)');
        const body = JSON.parse(req.body ?? '{}') as Record<string, unknown>;
        const r =
          route === 'PATCH grants'
            ? doc.updateGrants(body as never, ifMatch)
            : doc.setRegionState(decodeURIComponent(parts[3]!), body['state'] as never);
        return json(200, r.value, { etag: r.etag });
      }
      return problem('not_found', `no route ${route}`);
    } catch (e) {
      if (isPortError(e)) return problem(e.code, e.message);
      throw e;
    }
  }
}

interface Open {
  doc: string;
  channel: SyncChannel;
  offs: Unsubscribe[];
}

/** The server side of one socket. */
export class WireSession {
  readonly socket: ServerSocket;
  private readonly server: MockDepServer;
  private backend: MockBackend | null = null;
  private current: MockToken | null = null;
  private readonly channels = new Map<number, Open>();
  private readonly peers = new Set<string>();
  private chain: Promise<void> = Promise.resolve();
  ended = false;

  constructor(server: MockDepServer, socket: ServerSocket) {
    this.server = server;
    this.socket = socket;
    socket.onMessage = (text) => {
      this.chain = this.chain.then(() => this.receive(text)).catch(() => {});
    };
    socket.onClose = () => this.finish();
  }

  private send(m: ServerMessage | Record<string, unknown>): void {
    if (!this.ended) this.socket.send(codec.encode(m));
  }

  /** An `event` (05 §5.6) on every open channel of this session, as a server raises `asset.ready`. */
  event(type: string, resource: string): void {
    for (const ch of this.channels.keys()) this.send({ t: 'event', ch, d: { type, resource } });
  }

  private fatal(
    re: string | undefined,
    code: ErrorCode,
    message: string,
    close: number,
    extra: Record<string, unknown> = {},
  ): void {
    this.send({
      t: 'error',
      ...(re !== undefined ? { re } : {}),
      d: { code, message, retryable: false, fatal: true, ...extra },
    });
    this.socket.close(close, message);
    this.finish();
  }

  private async receive(text: string): Promise<void> {
    if (this.ended) return;
    const r = codec.decode(text, { receiver: 'server' });
    if (r.kind === 'unknown') {
      if (r.reply) this.send(r.reply);
      return;
    }
    if (r.kind === 'invalid') {
      this.send(r.reply);
      if (r.fatal) {
        this.socket.close(r.close ?? 4400, r.reason);
        this.finish();
      }
      return;
    }
    const m = r.message as ClientMessage;
    if (!this.backend && m.t !== 'hello') {
      this.socket.close(4400, 'hello must be the first message');
      this.finish();
      return;
    }
    switch (m.t) {
      case 'hello':
        return this.hello(m.id, m.d);
      case 'ping':
        this.send(m.id !== undefined ? { t: 'pong', re: m.id } : { t: 'pong' });
        return;
      case 'pong':
        return;
      case 'auth.refresh':
        return this.refresh(m.id, m.d.token);
      case 'ch.open':
        return this.open(m.id, m.ch, m.d);
      case 'ch.close':
        this.closeChannel(m.ch);
        return;
      case 'sync.submit':
        this.submit(m.id, m.ch, m.d);
        return;
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
    if (this.backend) return this.fatal(id, 'bad_message', 'hello was sent twice', 4400);
    if (!d.versions.includes('1.0'))
      return this.fatal(id, 'unsupported_version', 'no common protocol version', 4406, {
        versions: ['1.0'],
      });
    const token = this.server.token(d.token);
    if (!token) return this.fatal(id, 'unauthenticated', 'the token is not valid', 4401);
    this.current = token;
    const backend = new MockBackend(this.server.service, async () => this.current!, {
      features: d.features,
    });
    try {
      await backend.connect();
    } catch (e) {
      const code = isPortError(e) ? e.code : 'unauthenticated';
      return this.fatal(id, code, isPortError(e) ? e.message : 'refused', 4401);
    }
    this.backend = backend;
    backend.auth.onRevoked((e) => {
      this.send({ t: 'auth.revoked', d: { reason: e.reason } });
      this.socket.close(4401, 'revoked');
      this.finish();
    });
    backend.auth.onExpiring((e) => this.send({ t: 'auth.expiring', d: { inMs: e.inMs } }));
    const s = backend.auth.session!;
    this.send({
      t: 'welcome',
      re: id,
      d: this.server.welcomePayload({
        version: '1.0',
        session: s.session,
        user: s.user,
        features: s.features.filter((x) => x !== 'comments'),
        limits: s.limits,
        tokenExp: s.tokenExp,
      }),
    });
  }

  private async refresh(id: string, token: string): Promise<void> {
    const t = this.server.token(token);
    if (!t || t.sub !== this.current?.sub) {
      this.send({
        t: 'error',
        re: id,
        d: {
          code: 'unauthenticated',
          message: 'the token is not valid',
          retryable: false,
          fatal: false,
        },
      });
      return;
    }
    const before = this.current;
    this.current = t;
    try {
      const r = await this.backend!.auth.refresh();
      this.send({ t: 'auth.ok', re: id, d: { tokenExp: r.tokenExp } });
    } catch (e) {
      this.current = before;
      const code = isPortError(e) ? e.code : 'unauthenticated';
      this.send({
        t: 'error',
        re: id,
        d: { code, message: String(e), retryable: false, fatal: false },
      });
    }
  }

  private async open(
    id: string,
    ch: number,
    d: Extract<ClientMessage, { t: 'ch.open' }>['d'],
  ): Promise<void> {
    const reject = (code: ErrorCode, message: string) =>
      this.send({
        t: 'ch.rejected',
        re: id,
        ch,
        d: { code: CHANNEL_REJECT.has(code) ? code : 'unavailable', message },
      });
    // A client may use only announced features (05 §1 rule 4; PRO-006).
    const unannounced = d.features.filter((f) => !this.server.announcedFeatures().includes(f));
    if (unannounced.length)
      return reject('unsupported_feature', `not announced: ${unannounced.join(', ')}`);
    if ([...this.channels.values()].some((o) => o.doc === d.doc))
      return reject('already_open', 'one channel per document (05 §4)');
    // A projecting gateway forces a reload on a missing or different view token (ADR 0019): the
    // resume is kept for its `inflight` (D08), with an incarnation that cannot stream.
    const view = this.server.view();
    const resume =
      d.resume && view !== undefined && d.resume.view !== view
        ? { ...d.resume, incarnation: `${d.resume.incarnation}-other-view` }
        : d.resume;
    let channel: SyncChannel;
    try {
      channel = await this.backend!.sync.open(d.doc, resume ? { resume } : {});
    } catch (e) {
      return reject(
        isPortError(e) ? e.code : 'unavailable',
        isPortError(e) ? e.message : String(e),
      );
    }
    if (this.ended) {
      channel.close();
      return;
    }
    const open: Open = { doc: d.doc, channel, offs: [] };
    this.channels.set(ch, open);
    this.send({
      t: 'ch.opened',
      re: id,
      ch,
      d: view === undefined ? channel.opened : { ...channel.opened, view },
    });
    let firstAccess = true;
    let firstState = true;
    open.offs.push(
      channel.onCommits((commits) => this.send({ t: 'sync.commit', ch, d: { commits } })),
      channel.onReset((r) => this.send({ t: 'sync.reset', ch, d: r })),
      channel.onAccess((a) => {
        if (firstAccess) firstAccess = false;
        else this.send({ t: 'perm.changed', ch, d: a });
      }),
      channel.onEvent((e) => this.send({ t: 'event', ch, d: e })),
      channel.onCheck((c) => this.send({ t: 'sync.check', ch, d: c })),
      channel.onState((s) => {
        if (firstState) {
          firstState = false;
          return;
        }
        if (s.status === 'live') this.send({ t: 'sync.caughtUp', ch, d: { seq: s.seq } });
        else if (s.status === 'closed' && s.code !== null) {
          this.channels.delete(ch);
          this.send({
            t: 'ch.closed',
            ch,
            d: {
              code: s.code,
              reason: s.reason,
              ...(s.retryInMs !== undefined ? { retryInMs: s.retryInMs } : {}),
            },
          });
        }
      }),
    );
    const presence = this.backend!.presence;
    if (presence && !this.peers.has(d.doc)) {
      this.peers.add(d.doc);
      presence.onPeers(d.doc, (p) => {
        const live = [...this.channels.entries()].find(([, o]) => o.doc === d.doc);
        if (live) this.send({ t: 'presence.state', ch: live[0], d: p });
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
    if (!o) {
      this.send({
        t: 'error',
        re: id,
        ch,
        d: { code: 'unavailable', message: 'no such channel', retryable: true, fatal: false },
      });
      return;
    }
    o.channel.submit(d).then(
      (ack) => {
        if (this.channels.get(ch) === o) this.send({ t: 'sync.ack', re: id, ch, d: ack });
      },
      (e: unknown) => {
        if (this.channels.get(ch) !== o) return;
        if (isSyncReject(e)) this.send({ t: 'sync.reject', re: id, ch, d: e.toJSON() });
        else if (e instanceof PortError && e.code !== 'unavailable')
          this.send({
            t: 'error',
            re: id,
            ch,
            d: { code: 'bad_message', message: e.message, retryable: false, fatal: false },
          });
      },
    );
  }

  /** The socket closed: the server-side session ends. */
  finish(): void {
    if (this.ended) return;
    this.ended = true;
    for (const ch of [...this.channels.keys()]) this.closeChannel(ch);
    void this.backend?.close();
  }

  /** Test hook: sends any frame to the client. */
  push(frame: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(frame));
  }
}
