/**
 * `backend-dep`: the backend ports of 05 §8.3 over DEP (PRO-093, PRO-094). One WebSocket carries
 * the session and the document channels (05 §4, §5); the control plane is REST (05 §6).
 *
 * - connect(): discovery (05 §2), then the socket with the subprotocol `dep.v1`, then `hello` with
 *   a token from `getToken`; it resolves on `welcome`. `features` is what the client asked for and
 *   the server announced (05 §1 rule 4); it is empty until then (D23).
 * - The token travels only in `hello`, `auth.refresh` and `Authorization` headers, never in a URL
 *   (05 §3.1). It is held in memory only.
 * - A lost connection is reconnected with the backoff of 05 §4 (or the hint of `goaway`), and the
 *   open channels resume (04 §9; decision D80). A refused token is replaced once by a new one from
 *   `getToken` (05 §5.8); a revocation, a refused origin or an unsupported version end the session.
 * - close() closes the channels and the socket with a normal closure and cancels every timer.
 */
import {
  DEP1_WIRE,
  OrderedDelivery,
  PortError,
  ShapeValidator,
  isPortError,
  utf8Length,
  type Access,
  type AssetsPort,
  type AuthPort,
  type Backend,
  type ClientInfo,
  type ClientMessage,
  type CommentsPort,
  type Content,
  type Discovery,
  type ErrorCode,
  type ExportsPort,
  type FontsPort,
  type Grants,
  type HistoryPort,
  type ImportsPort,
  type LeasesPort,
  type Limits,
  type Notification,
  type PermissionsPort,
  type PresencePeers,
  type PresencePort,
  type PresenceUpdate,
  type RegionInfo,
  type RegionState,
  type RemoteCommit,
  type Resume,
  type ServerMessage,
  type Session,
  type SyncChannel,
  type SyncPort,
  type Tagged,
  type TokenSource,
  type Unsubscribe,
  type Welcome,
} from '@docedit/protocol';
import {
  ClientChannel,
  DEFAULT_ANSWER_TIMEOUT_MS,
  backoffDelay,
  checkDiscovery,
  clientCapabilities,
  type ChannelEffect,
  type ChannelOptions,
  type CloseVerdict,
} from '@docedit/protocol/client';
import { DepChannel, type ChannelHost } from './channel.ts';
import { Connection } from './connection.ts';
import { createFilePorts, type FilePorts } from './files.ts';
import { createReviewPorts, type ReviewPorts } from './review.ts';
import { Timers, platform, type Platform } from './platform.ts';
import { RestClient } from './rest.ts';

/** What `de-status` shows for the connection (05 §8.1; PRO-087). */
export type ConnectionStatus = 'online' | 'reconnecting' | 'offline';

/**
 * Features `backend-dep` asks for by default: those whose client side it implements. A host whose
 * editor reads CDM features (03 §11) adds them, so that documents requiring them can be opened.
 */
export const DEFAULT_FEATURES: readonly string[] = ['presence', 'regions', 'suggest-enforced'];

export interface DepBackendOptions {
  /** Base URL for discovery: `GET {endpoint}/.well-known/dep` (05 §2). */
  endpoint: string;
  /** The host's token source (05 §8.1 `getToken`): called at start, on `auth.expiring` and after a refusal. */
  getToken: TokenSource;
  /** The document the tokens are for, passed to `getToken` as `ctx.docId`. */
  docId?: string;
  /**
   * Features the client asks for in `hello` (05 §1 rule 4; default DEFAULT_FEATURES). The
   * negotiated set, `features`, is their intersection with what the server announces.
   */
  features?: readonly string[];
  /** `hello.client` (05 §5.1). */
  client?: ClientInfo;
  /** W3C trace context for `hello` and REST requests. */
  traceparent?: string;
  /** Replaces parts of the platform (tests: an in-memory network, virtual time). */
  platform?: Partial<Platform>;
  /** Receives what the client repaired or ignored: duplicates, gaps, unknown messages, reconnects. */
  onDiagnostic?: (d: Diagnostic) => void;
  /**
   * The host proxies Word imports (PRO-097; 05 §6.2; D16). The imports port has no feature name
   * (G06), so it is offered only when this is true; a browser backend must not call it directly.
   */
  proxyImports?: boolean;
}

export interface Diagnostic {
  kind: 'reconnect' | 'resume' | 'reload' | 'unknown' | 'error';
  message: string;
}

/** The connection status for `de-status`; not part of the port typings (ADR 0040). */
export interface ConnectionPort {
  readonly status: ConnectionStatus;
  onStatus(cb: (status: ConnectionStatus) => void): Unsubscribe;
}

/** Calls listeners in a later microtask, never synchronously (D21). */
class Listeners<T> {
  private readonly set = new Set<(v: T) => void>();
  add(cb: (v: T) => void): Unsubscribe {
    this.set.add(cb);
    return () => {
      this.set.delete(cb);
    };
  }
  emit(v: T): void {
    for (const cb of [...this.set]) void Promise.resolve().then(() => cb(v));
  }
}

/** The most commits one `GET /documents/{id}/commits` page asks for (PRO-026; PRO-040). */
const PAGE_LIMIT = 200;

const AUTH_CODES: ReadonlySet<string> = new Set(['unauthenticated', 'token_expired', 'revoked']);
/** Codes after which reconnecting cannot help without a change on the client's side. */
const FINAL_CODES: ReadonlySet<string> = new Set([
  ...AUTH_CODES,
  'forbidden',
  'unsupported_version',
  'unsupported_engine',
  'unsupported_cdm',
]);

const validator = new ShapeValidator(DEP1_WIRE);
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The two limits of `welcome` that bound one commit, as the channel enforces them (PRO-022). */
type CommitLimits = NonNullable<ChannelOptions['limits']>;
const commitLimits = (l: Limits): CommitLimits => ({
  maxCommitBytes: l.maxCommitBytes,
  maxStepsPerCommit: l.maxStepsPerCommit,
});

/** What the client knows about the projection a document's content belongs to (ADR 0019; D28). */
interface ViewNote {
  incarnation: string;
  view: string;
  from: number;
  to: number;
}

type Phase = 'idle' | 'connecting' | 'online' | 'reconnecting' | 'ended';

interface Pending {
  resolve(m: ServerMessage): void;
  reject(e: unknown): void;
  timer: number;
}

interface PresenceOut {
  lastSent: number;
  pending: PresenceUpdate | null;
  timer: number | null;
}

/** A `Backend` that speaks DEP to any conforming server. */
export class DepBackend implements Backend {
  readonly auth: AuthPort;
  readonly sync: SyncPort;
  readonly permissions: PermissionsPort;
  readonly connection: ConnectionPort;
  /**
   * The presence port, present while `presence` is negotiated (05 §8.3: the interface shows a
   * feature only when its port is present).
   */
  declare presence?: PresencePort;
  /**
   * The assets and exports ports, present while `assets` and `exports` are negotiated (PRO-096).
   * The fonts port has no feature name (G06), so it is present whenever the backend is.
   */
  declare assets?: AssetsPort;
  declare exports?: ExportsPort;
  /** The history, comments and leases ports, present while their features are negotiated (PRO-097). */
  declare history?: HistoryPort;
  declare comments?: CommentsPort;
  declare leases?: LeasesPort;
  /** Present only when the host proxies imports (`proxyImports`, PRO-097). */
  declare imports?: ImportsPort;
  readonly fonts: FontsPort;
  /** Every timer the backend armed; none remains after close(). */
  readonly timers: Timers;

  private readonly opts: DepBackendOptions;
  private readonly host: ChannelHost;
  private readonly p: Platform;
  private readonly requested: readonly string[];
  private readonly client: ClientInfo;
  private readonly presencePort: PresencePort;
  private phase: Phase = 'idle';
  /** Changes on every connect() and close(), so that a stale continuation stops. */
  private epoch = 0;
  private discovery: Discovery | null = null;
  private restClient: RestClient | null = null;
  private conn: Connection | null = null;
  private pendingConn: Connection | null = null;
  private token: string | null = null;
  /** The token for REST calls made without a session, or after the server refused one. */
  private restToken: string | null = null;
  private welcome: Welcome | null = null;
  private negotiated: ReadonlySet<string> = new Set();
  private connecting: Promise<void> | null = null;
  private attempts = 0;
  private reconnectTimer: number | null = null;
  private goawayHint: number | null = null;
  /** Stops the `pagehide` listener of connect(); none while the backend is closed (PRO-019). */
  private unhidePage: (() => void) | null = null;
  private revokedFlag = false;
  private nextCh = 1;
  private nextId = 1;
  private statusValue: ConnectionStatus = 'offline';
  private readonly channels = new Map<string, DepChannel>();
  private readonly byCh = new Map<number, DepChannel>();
  private readonly requests = new Map<string, Pending>();
  private readonly views = new Map<string, ViewNote>();
  private readonly accesses = new Map<string, Access>();
  private readonly presenceOut = new Map<string, PresenceOut>();
  private readonly portDelivery = new OrderedDelivery();
  private readonly expiring = new Listeners<{ inMs: number }>();
  private readonly revoked = new Listeners<{ reason: string }>();
  private readonly authRequired = new Listeners<{ code: ErrorCode; message: string }>();
  private readonly statusListeners = new Listeners<ConnectionStatus>();
  /** Every `event` message of the session: asset outcomes reach uploads through it (PRO-096). */
  private readonly notices = new Listeners<Notification>();
  private readonly files: FilePorts;
  private readonly review: ReviewPorts;

  constructor(options: DepBackendOptions) {
    this.opts = options;
    this.p = platform(options.platform);
    this.timers = new Timers(this.p);
    this.requested = [...new Set(options.features ?? DEFAULT_FEATURES)];
    this.client = options.client ?? { name: '@docedit/backend-dep', version: '0.0.0' };
    this.auth = withGetter(
      {
        refresh: () => this.refresh(),
        onExpiring: (cb: (e: { inMs: number }) => void) => this.expiring.add(cb),
        onRevoked: (cb: (e: { reason: string }) => void) => this.revoked.add(cb),
        onAuthRequired: (cb: (e: { code: ErrorCode; message: string }) => void) =>
          this.authRequired.add(cb),
      },
      'session',
      (): Session | null => this.welcome,
    );
    this.sync = {
      loadContent: (docId, seq) => this.loadContent(docId, seq),
      open: (docId, o) => this.open(docId, o.resume),
    };
    const base: PermissionsPort = {
      current: (docId) => this.accesses.get(docId) ?? null,
      onAccess: (docId, cb) => this.portDelivery.subscribe<Access>(`access:${docId}`, cb),
    };
    const regions: Required<
      Pick<PermissionsPort, 'regions' | 'grants' | 'updateGrants' | 'setRegionState'>
    > = {
      regions: (docId) =>
        this.rest().then((r) =>
          r.all<RegionInfo>(`/documents/${enc(docId)}/regions`, { shape: 'RegionInfo' }),
        ),
      grants: (docId) =>
        this.tagged<Grants>('GET', `/documents/${enc(docId)}/grants`, { shape: 'Grants' }),
      updateGrants: (docId, patch, o) =>
        this.tagged<Grants>('PATCH', `/documents/${enc(docId)}/grants`, {
          body: patch,
          ifMatch: o.ifMatch,
          shape: 'Grants',
        }),
      setRegionState: (docId, regionId, state, o) =>
        this.tagged<RegionState>('PUT', `/documents/${enc(docId)}/regions/${enc(regionId)}/state`, {
          body: { state },
          ifMatch: o.ifMatch,
          shape: 'RegionState',
        }),
    };
    // The region members exist when the server announces `regions` (D24).
    this.permissions = new Proxy(base, {
      get: (target, key) => {
        if (typeof key === 'string' && key in regions)
          return this.negotiated.has('regions') ? regions[key as keyof typeof regions] : undefined;
        return Reflect.get(target, key) as unknown;
      },
      has: (target, key) =>
        typeof key === 'string' && key in regions ? this.negotiated.has('regions') : key in target,
    });
    this.presencePort = {
      update: (docId, update) => this.presenceUpdate(docId, update),
      onPeers: (docId, cb) => this.portDelivery.subscribe<PresencePeers>(`presence:${docId}`, cb),
    };
    this.connection = withGetter(
      { onStatus: (cb: (status: ConnectionStatus) => void) => this.statusListeners.add(cb) },
      'status',
      (): ConnectionStatus => this.statusValue,
    );
    this.host = {
      now: () => this.p.now(),
      send: (ch, m) => this.channelSend(ch, m),
      armTimer: (ch) => this.armTimer(ch),
      page: (ch, after) => this.page(ch, after),
      scheduleReopen: (ch, e) => this.scheduleReopen(ch, e),
      accessChanged: (ch, a) => this.accessChanged(ch, a),
      peers: (ch, p) => this.peersArrived(ch, p),
      ended: (ch) => this.ended(ch),
    };
    this.files = createFilePorts({
      rest: () => this.rest(),
      fetch: this.p.fetch,
      notices: { add: (cb) => this.notices.add(cb) },
      clock: { set: (fn, ms) => this.timers.set(fn, ms), clear: (key) => this.timers.clear(key) },
      // The export targets of the discovery document, once it has been read (UX-101).
      exportTargets: () => this.discovery?.exportTargets ?? null,
    });
    this.fonts = this.files.fonts;
    this.review = createReviewPorts({
      rest: () => this.rest(),
      clock: {
        set: (fn, ms) => this.timers.set(fn, ms),
        clear: (key) => this.timers.clear(key),
        now: () => this.p.now(),
      },
    });
  }

  // --- Backend ---------------------------------------------------------------------------------

  /** Features both sides support (05 §1 rule 4); empty until connect() resolves (D23). */
  get features(): ReadonlySet<string> {
    return this.negotiated;
  }

  /** Sets the negotiated features and the optional ports that depend on them. */
  private setFeatures(features: Iterable<string>): void {
    this.negotiated = new Set(features);
    if (this.negotiated.has('presence')) this.presence = this.presencePort;
    else delete this.presence;
    if (this.negotiated.has('assets')) this.assets = this.files.assets;
    else delete this.assets;
    if (this.negotiated.has('exports')) this.exports = this.files.exports;
    else delete this.exports;
    if (this.negotiated.has('history')) this.history = this.review.history;
    else delete this.history;
    if (this.negotiated.has('comments')) this.comments = this.review.comments;
    else delete this.comments;
    if (this.negotiated.has('leases')) this.leases = this.review.leases;
    else delete this.leases;
    if (this.opts.proxyImports === true) this.imports = this.review.imports;
    else delete this.imports;
  }

  connect(): Promise<void> {
    if (this.phase === 'online') return Promise.resolve();
    if (this.connecting) return this.connecting;
    const reconnecting = this.phase === 'reconnecting';
    if (!reconnecting) {
      this.phase = 'connecting';
      this.revokedFlag = false;
      this.attempts = 0;
    }
    this.timers.clear(this.reconnectTimer);
    this.reconnectTimer = null;
    const epoch = this.epoch;
    this.unhidePage ??= this.p.onPageHide?.(() => this.pageHidden()) ?? null;
    this.connecting = this.establish(epoch)
      .catch((e: unknown) => {
        if (epoch === this.epoch) {
          if (reconnecting && !(isPortError(e) && FINAL_CODES.has(e.code)))
            this.scheduleReconnect();
          else this.end(isPortError(e) ? e.code : 'unavailable', messageOf(e));
        }
        throw e;
      })
      .finally(() => {
        this.connecting = null;
      });
    return this.connecting;
  }

  async close(): Promise<void> {
    this.epoch++;
    this.unhidePage?.();
    this.unhidePage = null;
    const wasOpen = this.phase !== 'idle';
    this.phase = 'idle';
    for (const ch of [...this.channels.values()]) ch.close();
    this.channels.clear();
    this.byCh.clear();
    this.accesses.clear();
    this.failRequests('the backend was closed');
    this.files.abort('the backend was closed');
    const conn = this.conn ?? this.pendingConn;
    this.conn = null;
    this.pendingConn = null;
    conn?.close(1000, 'closed by the client');
    this.welcome = null;
    this.token = null;
    this.restToken = null;
    this.setFeatures([]);
    this.presenceOut.clear();
    this.timers.clearAll();
    this.reconnectTimer = null;
    if (wasOpen) this.setStatus('offline');
  }

  // --- Session ---------------------------------------------------------------------------------

  private async establish(epoch: number): Promise<void> {
    const discovery = await this.loadDiscovery();
    this.check(epoch);
    let token = await this.obtainToken();
    this.check(epoch);
    try {
      await this.handshake(discovery, token, epoch);
    } catch (e) {
      if (!(isPortError(e) && AUTH_CODES.has(e.code)) || epoch !== this.epoch) throw e;
      // 05 §5.8: a refused token is retried once with a new one from getToken (PRO-039).
      token = await this.obtainToken();
      this.check(epoch);
      try {
        await this.handshake(discovery, token, epoch);
      } catch (e2) {
        if (isPortError(e2) && AUTH_CODES.has(e2.code))
          this.authRequired.emit({ code: e2.code, message: e2.message });
        throw e2;
      }
    }
  }

  private check(epoch: number): void {
    if (epoch !== this.epoch) throw new PortError('unavailable', 'the backend was closed');
  }

  private handshake(d: Discovery, token: string, epoch: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const conn = new Connection(this.p, this.timers, {
        welcome: (c, w, features) => {
          if (this.pendingConn !== c || epoch !== this.epoch) {
            c.close(1000, 'not needed');
            reject(new PortError('unavailable', 'the backend was closed'));
            return;
          }
          this.pendingConn = null;
          this.adopt(c, token, w, features);
          resolve();
        },
        failed: (c, error) => {
          if (this.pendingConn === c) this.pendingConn = null;
          reject(error);
        },
        message: (c, m) => {
          if (this.conn === c) this.dispatch(m);
        },
        closed: (c, verdict, reason) => {
          if (this.conn === c) this.lost(verdict, reason);
        },
      });
      this.pendingConn = conn;
      const hello = {
        token,
        client: this.client,
        features: this.requested,
        ids: () => this.id(),
        ...(this.opts.traceparent !== undefined ? { traceparent: this.opts.traceparent } : {}),
      };
      conn.start(d.ws, hello, this.answerTimeoutMs());
    });
  }

  private adopt(conn: Connection, token: string, w: Welcome, features: readonly string[]): void {
    this.conn = conn;
    this.token = token;
    this.welcome = w;
    this.setFeatures(features);
    this.phase = 'online';
    this.attempts = 0;
    this.goawayHint = null;
    this.setStatus('online');
    for (const ch of this.channels.values()) {
      ch.machine.answerTimeoutMs = w.limits.ackTimeoutMs;
      ch.machine.setLimits(commitLimits(w.limits));
      if (ch.machine.phase === 'resuming') {
        this.timers.clear(ch.reopenTimer);
        ch.reopenTimer = null;
        this.reopen(ch);
      }
    }
  }

  /** The connection ended after `welcome`. */
  /**
   * The page is hidden or unloaded: the socket closes so that the page can enter the back/forward
   * cache (PRO-019). The session is not ended; the close is reported as a lost connection, so the
   * client reconnects by its backoff if the page stays alive.
   */
  private pageHidden(): void {
    const conn = this.conn;
    if (this.phase !== 'online' || !conn) return;
    conn.close(1001, 'the page was hidden', { code: 'unavailable', reconnect: 'backoff' });
  }

  private lost(verdict: CloseVerdict, reason: string): void {
    this.conn = null;
    this.byCh.clear();
    this.failRequests(reason);
    if (this.phase !== 'online') return;
    if (this.revokedFlag) {
      // `auth.revoked`, then close 4401 (05 §3.3): the session is over; a new token reconnects.
      // PRO-016 criterion 5: the client asks getToken for a new token; a failure raises
      // onAuthRequired (the element's de-auth-required).
      this.end('revoked', reason);
      void this.obtainToken().catch(() => {});
      return;
    }
    if (verdict.reconnect === 'no') {
      this.end(verdict.code, reason);
      return;
    }
    for (const ch of [...this.channels.values()]) ch.apply(ch.machine.connectionLost(reason));
    this.phase = 'reconnecting';
    this.setStatus('reconnecting');
    this.diagnostic('reconnect', `${reason}; reconnecting`);
    this.scheduleReconnect(verdict.retryAfterMs);
  }

  private scheduleReconnect(retryAfterMs?: number): void {
    if (this.phase !== 'reconnecting' && this.phase !== 'connecting') return;
    this.phase = 'reconnecting';
    const delay =
      this.goawayHint ?? retryAfterMs ?? backoffDelay(this.attempts, () => this.p.random());
    this.goawayHint = null;
    this.attempts++;
    this.timers.clear(this.reconnectTimer);
    this.reconnectTimer = this.timers.set(() => {
      this.reconnectTimer = null;
      if (this.phase === 'reconnecting') void this.connect().catch(() => {});
    }, delay);
  }

  /** The session ended for good: channels close with `code`, and connect() starts afresh. */
  private end(code: ErrorCode, reason: string): void {
    if (this.phase === 'idle') return;
    this.epoch++;
    this.phase = 'ended';
    const conn = this.conn ?? this.pendingConn;
    this.conn = null;
    this.pendingConn = null;
    conn?.close(1000, 'the session ended');
    for (const ch of [...this.channels.values()]) ch.apply(ch.machine.terminate(code, reason));
    this.channels.clear();
    this.byCh.clear();
    this.accesses.clear();
    this.failRequests(reason);
    this.welcome = null;
    this.token = null;
    this.restToken = null;
    this.setFeatures([]);
    this.presenceOut.clear();
    this.timers.clearAll();
    this.reconnectTimer = null;
    this.setStatus('offline');
  }

  private dispatch(m: ServerMessage): void {
    if (m.t === 'event') this.notices.emit(m.d);
    switch (m.t) {
      case 'auth.expiring':
        this.expiring.emit({ inMs: m.d.inMs });
        // The backend refreshes by itself (PRO-014); a failure raises onAuthRequired.
        void this.refresh().catch(() => {});
        return;
      case 'auth.revoked':
        this.revokedFlag = true;
        this.revoked.emit({ reason: m.d.reason });
        return;
      case 'goaway':
        // The connection is draining (05 §5.1): reconnect after the hint when it closes.
        this.goawayHint = m.d.reconnectInMs;
        return;
      case 'auth.ok':
        this.answer(m.re, m);
        return;
      case 'error':
        if (m.re !== undefined && this.requests.has(m.re)) {
          this.answer(m.re, m);
          return;
        }
        break;
      default:
        break;
    }
    if ('ch' in m && typeof m.ch === 'number') {
      const ch = this.byCh.get(m.ch);
      if (ch && ch.machine.ch === m.ch) {
        ch.apply(ch.machine.receive(m, this.p.now()));
        return;
      }
    }
    if (m.t === 'error' && m.re !== undefined)
      for (const ch of this.channels.values())
        if (ch.machine.owns(m.re)) {
          ch.apply(ch.machine.receive(m, this.p.now()));
          return;
        }
    if (m.t === 'error') this.diagnostic('error', `${m.d.code}: ${m.d.message}`);
  }

  // --- AuthPort --------------------------------------------------------------------------------

  private tokenContext(): { docId?: string } {
    return this.opts.docId === undefined ? {} : { docId: this.opts.docId };
  }

  /** A token from the host; a failure raises onAuthRequired and rejects with `unauthenticated` (05 §5.8). */
  private async obtainToken(): Promise<string> {
    let token: unknown;
    try {
      token = await this.opts.getToken(this.tokenContext());
    } catch (e) {
      const message = `the token source failed: ${messageOf(e)}`;
      this.authRequired.emit({ code: 'unauthenticated', message });
      throw new PortError('unauthenticated', message);
    }
    if (typeof token !== 'string' || token.length === 0) {
      const message = 'the token source returned no token';
      this.authRequired.emit({ code: 'unauthenticated', message });
      throw new PortError('unauthenticated', message);
    }
    return token;
  }

  private async refresh(): Promise<{ tokenExp: string }> {
    if (this.phase !== 'online' || !this.conn) throw new PortError('unavailable', 'not connected');
    const token = await this.obtainToken();
    const conn = this.conn;
    if (this.phase !== 'online' || !conn) throw new PortError('unavailable', 'not connected');
    const id = this.id();
    const reply = await this.request(conn, { t: 'auth.refresh', id, d: { token } }, id);
    if (reply.t === 'error') {
      const e = new PortError(reply.d.code, reply.d.message);
      if (AUTH_CODES.has(reply.d.code))
        this.authRequired.emit({ code: reply.d.code, message: reply.d.message });
      throw e;
    }
    if (reply.t !== 'auth.ok') throw new PortError('internal', `unexpected ${reply.t}`);
    this.token = token;
    if (this.welcome) this.welcome = { ...this.welcome, tokenExp: reply.d.tokenExp };
    return { tokenExp: reply.d.tokenExp };
  }

  private request(conn: Connection, message: ClientMessage, id: string): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      const timer = this.timers.set(() => {
        this.requests.delete(id);
        reject(new PortError('unavailable', `no answer to ${message.t}`));
      }, this.answerTimeoutMs());
      this.requests.set(id, { resolve, reject, timer });
      try {
        conn.send(message);
      } catch (e) {
        this.timers.clear(timer);
        this.requests.delete(id);
        reject(new PortError('bad_message', messageOf(e)));
      }
    });
  }

  private answer(re: string, m: ServerMessage): void {
    const p = this.requests.get(re);
    if (!p) return;
    this.requests.delete(re);
    this.timers.clear(p.timer);
    p.resolve(m);
  }

  private failRequests(reason: string): void {
    for (const p of this.requests.values()) {
      this.timers.clear(p.timer);
      p.reject(new PortError('unavailable', reason));
    }
    this.requests.clear();
  }

  // --- SyncPort --------------------------------------------------------------------------------

  private async loadContent(docId: string, seq?: number): Promise<Content> {
    const rest = await this.rest();
    const r = await rest.call<Content>('GET', `/documents/${enc(docId)}/content`, {
      ...(seq !== undefined ? { query: { seq } } : {}),
      shape: 'Content',
    });
    const c = r.value;
    // The view token of a content read is echoed in a resume from that content (D70; D81).
    if (c.view !== undefined) this.noteView(docId, c.incarnation, c.view, c.seq);
    return c;
  }

  /**
   * Records that the content of `docId` at `seq` belongs to `view`. Seqs between two notes of the
   * same view and incarnation belong to it too: a change of view closes the channel (ADR 0019).
   */
  private noteView(docId: string, incarnation: string, view: string, seq: number): void {
    const n = this.views.get(docId);
    if (n && n.incarnation === incarnation && n.view === view)
      this.views.set(docId, {
        incarnation,
        view,
        from: Math.min(n.from, seq),
        to: Math.max(n.to, seq),
      });
    else this.views.set(docId, { incarnation, view, from: seq, to: seq });
  }

  private async open(docId: string, resume: Resume | undefined): Promise<SyncChannel> {
    if (this.phase !== 'online' || !this.conn) throw new PortError('unavailable', 'not connected');
    const existing = this.channels.get(docId);
    if (existing && !existing.isClosed)
      throw new PortError(
        'already_open',
        'a channel for this document is open on this connection (05 §4)',
      );
    const machine = new ClientChannel({
      doc: docId,
      ids: () => this.id(),
      cdm: clientCapabilities().cdm.max,
      answerTimeoutMs: this.answerTimeoutMs(),
      // PRO-022: the commit limits the server advertised, so that no oversize commit is built.
      ...(this.welcome ? { limits: commitLimits(this.welcome.limits) } : {}),
    });
    const ch = new DepChannel(this.host, machine);
    this.channels.set(docId, ch);
    const n = this.nextCh++;
    this.byCh.set(n, ch);
    const opened = ch.whenOpen();
    ch.apply(
      machine.open(n, [...this.negotiated], resume && this.withView(docId, resume), this.p.now()),
    );
    return opened;
  }

  /** Fills `resume.view` from the content read or channel the resume point came from (D81). */
  private withView(docId: string, resume: Resume): Resume {
    if (resume.view !== undefined) return resume;
    const note = this.views.get(docId);
    if (!note || note.incarnation !== resume.incarnation) return resume;
    if (resume.seq < note.from || resume.seq > note.to) return resume;
    return { ...resume, view: note.view };
  }

  // --- ChannelHost -----------------------------------------------------------------------------

  private channelSend(ch: DepChannel, message: ClientMessage): void {
    const conn = this.conn;
    if (!conn || !conn.ready) return;
    try {
      conn.send(message);
    } catch (e) {
      // An invalid message never leaves the client; its request fails as the server would fail it.
      if ('id' in message && typeof message.id === 'string')
        ch.apply(
          ch.machine.receive(
            {
              t: 'error',
              re: message.id,
              d: { code: 'bad_message', message: messageOf(e), retryable: false, fatal: false },
            },
            this.p.now(),
          ),
        );
    }
  }

  private armTimer(ch: DepChannel): void {
    this.timers.clear(ch.timer);
    ch.timer = null;
    const at = ch.machine.deadline();
    if (at === null || ch.machine.phase === 'closed') return;
    ch.timer = this.timers.set(() => {
      ch.timer = null;
      ch.apply(ch.machine.tick(this.p.now()));
    }, at - this.p.now());
  }

  private page(ch: DepChannel, after: number): void {
    void this.rest()
      .then((rest) =>
        rest.call<{ items: RemoteCommit[]; nextCursor: string | null }>(
          'GET',
          `/documents/${enc(ch.docId)}/commits`,
          // PRO-026 criterion 1: at most 200 commits per page (PRO-040; the server's limit is 1 to 200).
          { query: { after, limit: PAGE_LIMIT }, shape: 'RemoteCommit', list: true },
        ),
      )
      .then(
        (r) => {
          if (this.channels.get(ch.docId) === ch)
            ch.apply(ch.machine.paged(r.value.items, this.p.now()));
        },
        (e: unknown) => {
          if (this.channels.get(ch.docId) === ch) ch.apply(ch.machine.pageFailed(messageOf(e)));
        },
      );
  }

  private scheduleReopen(ch: DepChannel, e: Extract<ChannelEffect, { kind: 'reopen' }>): void {
    this.timers.clear(ch.reopenTimer);
    ch.reopenTimer = null;
    this.diagnostic('resume', `${ch.docId}: ${e.reason}`);
    // Without a connection, the channel reopens when the next session opens.
    if (this.phase !== 'online') return;
    const delay = e.delayMs ?? backoffDelay(e.attempt - 1, () => this.p.random());
    ch.reopenTimer = this.timers.set(() => {
      ch.reopenTimer = null;
      if (this.phase === 'online' && ch.machine.phase === 'resuming') this.reopen(ch);
    }, delay);
  }

  private reopen(ch: DepChannel): void {
    const n = this.nextCh++;
    this.byCh.set(n, ch);
    ch.apply(ch.machine.reopen(n, [...this.negotiated], this.p.now()));
  }

  private accessChanged(ch: DepChannel, access: Access): void {
    if (this.channels.get(ch.docId) !== ch) return;
    this.accesses.set(ch.docId, access);
    this.portDelivery.push(`access:${ch.docId}`, access);
    const m = ch.machine;
    if (m.view !== undefined && m.incarnation !== null)
      this.noteView(ch.docId, m.incarnation, m.view, m.seq);
  }

  private peersArrived(ch: DepChannel, peers: PresencePeers): void {
    if (this.channels.get(ch.docId) === ch) this.portDelivery.push(`presence:${ch.docId}`, peers);
  }

  private ended(ch: DepChannel): void {
    this.timers.clear(ch.timer);
    this.timers.clear(ch.reopenTimer);
    ch.timer = null;
    ch.reopenTimer = null;
    const m = ch.machine;
    // The channel's confirmed point keeps its view for a later resume (ADR 0019; D81). A view that
    // went stale meanwhile is harmless: the server answers a resume with it with a reload.
    if (m.view !== undefined && m.incarnation !== null && m.opened !== null)
      this.noteView(ch.docId, m.incarnation, m.view, m.seq);
    if (this.channels.get(ch.docId) === ch) {
      this.channels.delete(ch.docId);
      this.accesses.delete(ch.docId);
      const out = this.presenceOut.get(ch.docId);
      if (out) this.timers.clear(out.timer);
      this.presenceOut.delete(ch.docId);
    }
    for (const [n, c] of this.byCh) if (c === ch) this.byCh.delete(n);
  }

  // --- PresencePort ----------------------------------------------------------------------------

  /** `presence.update` at most `presenceHz` times a second, the latest state winning (04 §11). */
  private presenceUpdate(docId: string, update: PresenceUpdate): void {
    const limits = this.welcome?.limits;
    if (!this.negotiated.has('presence') || !limits) return;
    // 05 §5.4: the state must fit `presenceBytes`; a larger one is never sent.
    if (utf8Length(JSON.stringify(update.state)) > limits.presenceBytes) return;
    const ch = this.channels.get(docId);
    if (!ch || ch.machine.phase !== 'live') return;
    let out = this.presenceOut.get(docId);
    if (!out) {
      out = { lastSent: -Infinity, pending: null, timer: null };
      this.presenceOut.set(docId, out);
    }
    const interval = limits.presenceHz > 0 ? 1000 / limits.presenceHz : 0;
    const now = this.p.now();
    if (out.timer === null && now - out.lastSent >= interval) {
      this.sendPresence(ch, out, update, now);
      return;
    }
    out.pending = update;
    if (out.timer === null) {
      const state = out;
      state.timer = this.timers.set(
        () => {
          state.timer = null;
          const next = state.pending;
          state.pending = null;
          const live = this.channels.get(docId);
          if (next && live && live.machine.phase === 'live')
            this.sendPresence(live, state, next, this.p.now());
        },
        out.lastSent + interval - now,
      );
    }
  }

  private sendPresence(
    ch: DepChannel,
    out: PresenceOut,
    update: PresenceUpdate,
    now: number,
  ): void {
    if (ch.machine.ch === null) return;
    out.lastSent = now;
    this.channelSend(ch, { t: 'presence.update', ch: ch.machine.ch, d: update });
  }

  // --- Control plane ---------------------------------------------------------------------------

  private async loadDiscovery(): Promise<Discovery> {
    if (this.discovery) return this.discovery;
    const url = `${this.opts.endpoint.replace(/\/+$/, '')}/.well-known/dep`;
    let text: string;
    let status: number;
    try {
      const res = await this.p.fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
      });
      status = res.status;
      text = await res.text();
    } catch (e) {
      throw new PortError('unavailable', `discovery failed: ${messageOf(e)}`);
    }
    if (status !== 200) throw new PortError('unavailable', `discovery answered ${status}`);
    let d: unknown;
    try {
      d = JSON.parse(text);
    } catch {
      throw new PortError('unavailable', 'the discovery document is not JSON');
    }
    // Only the members a client acts on are required here; the rest is the server's business.
    const problems = validator
      .checkNamed('Discovery', d)
      .filter((v) => !v.path.startsWith('/jwks_uri') && !v.path.startsWith('/mode'));
    if (problems.length)
      throw new PortError(
        'unavailable',
        `the discovery document is not valid: ${problems.map((v) => `${v.path} ${v.message}`).join('; ')}`,
      );
    const discovery = d as Discovery;
    const mismatch = checkDiscovery(discovery);
    if (mismatch) throw new PortError(mismatch.code, mismatch.message);
    this.discovery = discovery;
    return discovery;
  }

  private async rest(): Promise<RestClient> {
    if (this.restClient) return this.restClient;
    const d = await this.loadDiscovery();
    this.restClient ??= new RestClient(d.rest, this.p, {
      // The session's token, or before a session one token for every REST call (05 §3.1).
      token: async () =>
        this.token ?? this.restToken ?? (this.restToken = await this.obtainToken()),
      renew: async () => {
        const t = await this.obtainToken();
        this.restToken = t;
        return t;
      },
    });
    return this.restClient;
  }

  private async tagged<T>(
    method: string,
    path: string,
    req: { body?: unknown; ifMatch?: string; shape: string },
  ): Promise<Tagged<T>> {
    const r = await (await this.rest()).call<T>(method, path, req);
    return { value: r.value, etag: r.etag ?? '' };
  }

  // --- Small parts -----------------------------------------------------------------------------

  private id(): string {
    return String(this.nextId++);
  }

  private answerTimeoutMs(): number {
    const l: Limits | undefined = this.welcome?.limits;
    return l?.ackTimeoutMs ?? DEFAULT_ANSWER_TIMEOUT_MS;
  }

  private setStatus(s: ConnectionStatus): void {
    if (this.statusValue === s) return;
    this.statusValue = s;
    this.statusListeners.emit(s);
  }

  private diagnostic(kind: Diagnostic['kind'], message: string): void {
    const cb = this.opts.onDiagnostic;
    if (cb) void Promise.resolve().then(() => cb({ kind, message }));
  }
}

const enc = (s: string): string => encodeURIComponent(s);

/** `o` with a read-only property `key` computed by `get` on every read. */
function withGetter<T extends object, K extends string, V>(
  o: T,
  key: K,
  get: () => V,
): T & { readonly [P in K]: V } {
  Object.defineProperty(o, key, { get, enumerable: true });
  return o as T & { readonly [P in K]: V };
}

/** The entry point the element imports when it has an `endpoint` and no `backend` (05 §8.1). */
export function createDepBackend(options: DepBackendOptions): DepBackend {
  return new DepBackend(options);
}
