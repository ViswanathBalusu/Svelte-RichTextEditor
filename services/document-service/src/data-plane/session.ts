/**
 * One DEP session: one WebSocket connection (05 §4, §5.1, §5.2; BE-029; PRO-017, PRO-021,
 * PRO-037). The first message must be `hello`, within 10 seconds; the token is verified, the
 * `Origin` header is checked against the tenant's origins now that the tenant is known, and
 * `welcome` carries every limit. Then the session multiplexes document channels, each attached to
 * the room of its document.
 *
 * Frames are handled one after another, in arrival order, so that the messages of a channel reach
 * its room in the order sent (05 §4). Every frame is one JSON object in one text frame; a frame that
 * is not, is binary, is not UTF-8 or breaks the envelope closes the connection with 4400, a frame
 * above `maxMessageBytes` with 4413 (decision D03). Every close is one of the codes of 05 §5.7, and
 * a fatal `error` whose code implies it comes first (D25).
 *
 * Phase 1b (packet A):
 * - Features (05 §1 rule 4; 03 §11.1; D120, D121): a `ch.open` that names a feature the server did
 *   not announce, or that lacks one the document requires, is rejected with `unsupported_feature`;
 *   the channel's features are kept for the room.
 * - Token refresh (PRM-021): a refreshed token's roles and groups reach the room, which sends
 *   `perm.changed`; a token that no longer names the document closes the channel.
 * - Send queues (06 §2.4; BE-027): at most `socketHighWater` bytes are handed to the socket and not
 *   yet flushed; the rest waits in one queue, counted per channel. A channel whose waiting bytes
 *   pass `sendQueueBytes` is closed with `slow_consumer` and its waiting messages are dropped; the
 *   client resumes from its last `seq`. A chunked message is queued and sent as one unit.
 * - Rate limits (BE-030): frames per address before `hello`, then messages per connection, user
 *   and tenant. A refused submit is answered with `sync.reject` `rate_limited` and `retryAfterMs`,
 *   anything else with a non-fatal `error`; refusals in a row close the connection with 4429.
 * - Traces (BE-087; PRO-044): the session and its channels and commits are spans of the trace of
 *   `hello.traceparent`, or of a new trace.
 */
import type { IncomingMessage } from 'node:http';
import { formatTimestamp, uuid7 } from '@docedit/model';
import { mayOpen } from '@docedit/model/definition';
import {
  Reassembler,
  chunkMessage,
  depCodec,
  utf8Length,
  type AuthRefreshMessage,
  type ChannelClosed,
  type ChCloseMessage,
  type ChOpenMessage,
  type ChunkMessage,
  type ErrorMessage,
  type HelloMessage,
  type PresenceUpdateMessage,
  type ServerMessage,
  type SyncSubmitMessage,
} from '@docedit/protocol';
import type { RoomConnection } from '@docedit/authority';
import type { WebSocket, RawData } from 'ws';
import type { GrantStore } from '../storage/types.ts';
import type { VerifiedIdentity, VerifyToken } from '../seams.ts';
import { recordAsserted, type AssertedRecord } from './asserted-claims.ts';
import { SessionEngines, engineRegistry } from './engines.ts';
import type { RateLimits, TokenBucket } from './limits.ts';
// The live-use quota gate (BE-091) lives in a leaf module so that `seams.ts` can name it without
// importing this file; it is re-exported here for existing importers.
import type { LiveQuotaGate } from './quota-gate.ts';
export type { LiveQuotaGate } from './quota-gate.ts';
import type { Metrics } from './metrics.ts';
import type { ChannelPort, HostedRoom, RoomHost } from './room-host.ts';
import { connectionOf } from './room-host.ts';
import type { Settings } from './settings.ts';
import { parseTraceparent, type OpenSpan, type TraceContext, type Tracer } from './tracing.ts';
import {
  CLOSE,
  Refusal,
  closeCodeOf,
  retryable,
  socketCodeOf,
  type SocketErrorCode,
} from './wire.ts';

const codec = depCodec();
const utf8 = new TextDecoder('utf-8', { fatal: true });

export interface SessionDeps {
  readonly settings: Settings;
  readonly verify: VerifyToken;
  readonly allowedOrigins: ((tenant: string) => Promise<readonly string[]>) | undefined;
  readonly host: RoomHost;
  readonly grants: GrantStore;
  /** Whether the wire shows the host's `sub` (D42); without a user lookup it shows surrogates. */
  readonly usersOnWire: boolean;
  readonly now: () => number;
  /** The session ended; the data plane forgets it. */
  ended(session: Session): void;
  // --- Phase 1b ---------------------------------------------------------------------------------
  readonly limits: RateLimits;
  /** The live-use quota gate (BE-091); absent when the node composes no quotas. */
  readonly quotas?: LiveQuotaGate | undefined;
  readonly metrics: Metrics;
  readonly tracer: Tracer;
  /** The remote address, for the limits before authentication (BE-030). */
  readonly address: string;
}

interface SessionChannel {
  readonly ch: number;
  readonly doc: string;
  /** The room's channel identifier: unique on this node. */
  readonly key: string;
  state: 'opening' | 'open';
  room: HostedRoom | null;
  /** The identity the channel was opened with: the session's, or that of its own token. */
  identity: VerifiedIdentity;
  /**
   * The `wfp`, `amr` and `auth_time` of the token in force on the channel, recorded as given when
   * it was accepted (PRO-015 criterion 3; asserted-claims.ts), or undefined when it carried none.
   */
  asserted: AssertedRecord | undefined;
  conn: RoomConnection | null;
  /** Whether the channel has a token of its own (`ch.open.token`, `auth.refresh` with `ch`). */
  own: boolean;
  expiry: ReturnType<typeof setTimeout> | null;
  /** The features the client announced for this channel (03 §11.1). */
  features: readonly string[];
  span: OpenSpan | null;
}

/** Frames of one message, sent as one unit (05 §4: the chunks of a message are consecutive). */
interface Outgoing {
  /** The channel the message belongs to, or null for the session's own messages. */
  readonly ch: number | null;
  readonly frames: readonly string[];
  readonly bytes: number;
}

type Timer = ReturnType<typeof setTimeout>;

/** The role of a token in a document, from its `docs` claim (05 §3.1). */
function roleIn(identity: VerifiedIdentity, doc: string): RoomConnection['role'] | undefined {
  return identity.docs[doc];
}

/** Messages that are never rate limited: keep-alive, and what a client says when it leaves. */
const UNLIMITED = new Set(['ping', 'pong', 'ch.close', 'error']);

export class Session {
  /** A new identifier for every connection; there is no session resumption (05 §5.1). */
  readonly id: string = uuid7();
  readonly #ws: WebSocket;
  readonly #origin: string | undefined;
  readonly #deps: SessionDeps;
  #state: 'hello' | 'open' | 'closed' = 'hello';
  /** The tenant whose connection quota this session holds (BE-091), released when it ends. */
  #connectionTenant: string | null = null;
  #done = false;
  #draining = false;
  /** When the socket was accepted, for the connection time of BE-085. */
  readonly #connectedAt: number;
  #identity: VerifiedIdentity | null = null;
  #features: readonly string[] = [];
  /** The engines negotiated from `hello.engines` (SYN-046 criterion 4); set by `hello`. */
  #engines: SessionEngines | null = null;
  readonly #channels = new Map<number, SessionChannel>();
  #queue: Promise<void> = Promise.resolve();
  readonly #reassembler: Reassembler;
  #chunkBytes = 0;
  #helloTimer: Timer | null = null;
  #expiringTimer: Timer | null = null;
  #expiryTimer: Timer | null = null;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #lastHeard = Date.now();
  #lastSent = Date.now();
  // Send queues (BE-027).
  #out: Outgoing[] = [];
  readonly #waiting = new Map<number, number>();
  #inFlight = 0;
  // Rate limits (BE-030).
  #bucket: TokenBucket | null = null;
  #refusals = 0;
  // Traces (BE-087).
  #trace: TraceContext | null = null;
  #span: OpenSpan | null = null;

  constructor(ws: WebSocket, req: IncomingMessage, deps: SessionDeps) {
    this.#ws = ws;
    this.#deps = deps;
    this.#connectedAt = deps.now();
    const origin = req.headers.origin;
    this.#origin = typeof origin === 'string' ? origin : undefined;
    this.#reassembler = new Reassembler({ timeoutMs: deps.settings.chunkTimeoutMs });
    ws.on('message', (data, isBinary) => this.#frame(data, isBinary));
    ws.on('close', () => this.#ended());
    ws.on('error', (e) => {
      this.#deps.settings.onError(e, 'socket');
      this.#ended();
    });
    // 05 §5.1: `hello` must arrive within 10 seconds. A token in the URL is never read (BE-029).
    this.#helloTimer = setTimeout(() => {
      if (this.#state === 'hello') this.#close(CLOSE.helloTimeout, 'hello not received in time');
    }, deps.settings.helloTimeoutMs);
    this.#helloTimer.unref?.();
  }

  get identity(): VerifiedIdentity | null {
    return this.#identity;
  }

  /**
   * What the host asserted about the participant on channel `ch` (`wfp`, `amr`, `auth_time`), as
   * recorded when its token was accepted (PRO-015 criterion 3; 12 §7). Undefined when the channel
   * is not open or its token carried none. Not identity proof: nothing checks or sends it.
   */
  assertedClaims(ch: number): AssertedRecord | undefined {
    const c = this.#channels.get(ch);
    return c?.state === 'open' ? c.asserted : undefined;
  }

  get open(): boolean {
    return this.#state !== 'closed';
  }

  /** Bytes waiting in this session's queues, for the metrics (BE-027 criterion 4). */
  get queuedBytes(): number {
    let n = 0;
    for (const e of this.#out) n += e.bytes;
    return n;
  }

  /** Read through a method: the state can change while a handler awaits. */
  #isClosed(): boolean {
    return this.#state === 'closed';
  }

  // --- Frames (05 §4) --------------------------------------------------------------------------

  #frame(data: RawData, isBinary: boolean): void {
    this.#lastHeard = Date.now();
    if (this.#state === 'closed') return;
    // BE-030: before `hello` is accepted, frames count against the address; no token is verified
    // for an address over its limit.
    if (this.#state === 'hello' && this.#deps.limits.frame(this.#deps.address, Date.now()) > 0) {
      this.#deps.metrics.rateLimited.inc({ scope: 'address' });
      return this.#fatal('rate_limited', 'too many frames from this address');
    }
    if (isBinary) return this.#fatal('bad_message', 'pm-steps/1 uses no binary frames');
    const bytes = Array.isArray(data)
      ? Buffer.concat(data)
      : data instanceof ArrayBuffer
        ? Buffer.from(data)
        : data;
    const max = this.#deps.settings.limits.maxMessageBytes;
    if (bytes.length > max)
      return this.#fatal('too_large', `the frame is larger than ${max} bytes`);
    let text: string;
    try {
      text = utf8.decode(bytes);
    } catch {
      return this.#fatal('bad_message', 'the frame is not UTF-8');
    }
    this.#enqueue(() => this.#message(text, false));
  }

  #enqueue(task: () => void | Promise<void>): void {
    this.#queue = this.#queue
      .then(() => (this.#state === 'closed' ? undefined : task()))
      .catch((e: unknown) => {
        this.#deps.settings.onError(e, 'session');
        this.#fatal('internal', 'the server failed to handle the message');
      });
  }

  async #message(text: string, reassembled: boolean): Promise<void> {
    if (this.#state === 'closed') return;
    const max = this.#deps.settings.limits.maxMessageBytes;
    const r = codec.decode(
      text,
      reassembled ? { receiver: 'server' } : { receiver: 'server', maxMessageBytes: max },
    );
    if (r.kind === 'invalid') {
      if (r.fatal || this.#state === 'hello')
        return this.#fatalReply(r.reply, r.close ?? CLOSE.badMessage);
      return this.#send(r.reply);
    }
    if (r.kind === 'unknown') {
      if (this.#state === 'hello')
        return this.#fatal('bad_message', `the first message must be hello, not ${r.t}`);
      if (r.reply) this.#send(r.reply);
      return;
    }
    const m = r.message;
    if (this.#state === 'hello') {
      if (m.t !== 'hello')
        return this.#fatal('bad_message', `the first message must be hello, not ${m.t}`);
      return this.#hello(m);
    }
    // The chunks of one message count as that message (BE-030).
    if (!reassembled && m.t !== 'chunk' && !UNLIMITED.has(m.t) && !this.#admit(m)) return;
    switch (m.t) {
      case 'hello':
        return this.#error('bad_message', 'the session is already open', m.id);
      case 'ping':
        return this.#send({ t: 'pong', ...(m.id !== undefined ? { re: m.id } : {}) });
      case 'pong':
      case 'error':
        return;
      case 'chunk':
        return reassembled
          ? this.#fatal('bad_message', 'a chunk inside a chunked message')
          : this.#chunk(m);
      case 'auth.refresh':
        return this.#refresh(m);
      case 'ch.open':
        return this.#openChannel(m);
      case 'ch.close':
        return this.#closeChannel(m);
      case 'sync.submit':
        // BE-091: a commit over the tenant's commit-rate quota is answered and not submitted.
        if (this.#commitRefused(m)) return;
        return this.#submit(m);
      case 'presence.update':
        return this.#presence(m);
      default:
        // Messages a server sends are refused by the codec (wrong direction): nothing reaches here.
        return;
    }
  }

  /**
   * The limits of an open session (BE-030): the connection's own bucket, then the user's and the
   * tenant's. A refused message is answered and dropped; too many refusals in a row end the
   * connection with 4429.
   */
  #admit(m: { t: string; id?: string; ch?: number; d?: unknown }): boolean {
    const now = Date.now();
    const id = this.#identity!;
    const own = this.#bucket?.take(now) ?? 0;
    const shared =
      own > 0
        ? { scope: 'connection' as const, waitMs: own }
        : this.#deps.limits.message(id.tenant, id.connection.sub, now);
    if (!shared) {
      this.#refusals = 0;
      return true;
    }
    this.#deps.metrics.rateLimited.inc({ tenant: id.tenant, scope: shared.scope });
    if (++this.#refusals >= this.#deps.settings.rates.closeAfterRefusals) {
      this.#fatal('rate_limited', 'too many messages');
      return false;
    }
    const retryAfterMs = Math.max(1, shared.waitMs);
    const c = m.ch !== undefined ? this.#channels.get(m.ch) : undefined;
    if (m.t === 'sync.submit' && c?.room && m.id !== undefined) {
      const d = m.d as { id?: unknown } | undefined;
      this.#send({
        t: 'sync.reject',
        re: m.id,
        ch: c.ch,
        d: {
          id: typeof d?.id === 'string' ? d.id : '',
          code: 'rate_limited',
          message: `the ${shared.scope} limit is reached`,
          action: 'retry',
          head: c.room.head,
          retryAfterMs,
        },
      });
      return false;
    }
    this.#send({
      t: 'error',
      ...(m.id !== undefined ? { re: m.id } : {}),
      ...(m.ch !== undefined ? { ch: m.ch } : {}),
      d: {
        code: 'rate_limited',
        message: `the ${shared.scope} limit is reached`,
        retryable: true,
        retryAfterMs,
        fatal: false,
      },
    });
    return false;
  }

  /**
   * BE-091: admits one commit against the tenant's commit-rate quota. A refused commit is answered
   * with `sync.reject` (`quota_exceeded`, `retryAfterMs`) when its channel has a room, else with an
   * `error`. Returns true when the commit must not be submitted.
   */
  #commitRefused(m: { t: string; id?: string; ch?: number; d?: unknown }): boolean {
    const quotas = this.#deps.quotas;
    if (!quotas || !this.#identity) return false;
    const adm = quotas.admitCommit(this.#identity.tenant);
    if (adm.ok) return false;
    const message = 'the commit-rate quota of the tenant is reached';
    const c = m.ch !== undefined ? this.#channels.get(m.ch) : undefined;
    if (c?.room && m.id !== undefined) {
      const d = m.d as { id?: unknown } | undefined;
      this.#send({
        t: 'sync.reject',
        re: m.id,
        ch: c.ch,
        d: {
          id: typeof d?.id === 'string' ? d.id : '',
          code: 'quota_exceeded',
          message,
          action: 'retry',
          head: c.room.head,
          retryAfterMs: adm.retryAfterMs,
        },
      });
      return true;
    }
    this.#send({
      t: 'error',
      ...(m.id !== undefined ? { re: m.id } : {}),
      ...(m.ch !== undefined ? { ch: m.ch } : {}),
      d: {
        code: 'quota_exceeded',
        message,
        retryable: true,
        retryAfterMs: adm.retryAfterMs,
        fatal: false,
      },
    });
    return true;
  }

  /** 05 §4: a message larger than `maxMessageBytes` arrives as consecutive chunks. */
  async #chunk(m: ChunkMessage): Promise<void> {
    this.#chunkBytes += utf8Length(m.d.part);
    if (this.#chunkBytes > this.#deps.settings.maxReassembledBytes)
      return this.#fatal('too_large', 'the chunked message is larger than the server accepts');
    const r = this.#reassembler.push(m.d, Date.now());
    if (r.status === 'partial') return;
    this.#chunkBytes = 0;
    // What a broken reassembly means is not stated (G14): the stream can no longer be trusted.
    if (r.status === 'error') return this.#fatal('bad_message', r.reason);
    return this.#message(r.text, true);
  }

  // --- Session (05 §5.1) -----------------------------------------------------------------------

  async #hello(m: HelloMessage): Promise<void> {
    if (this.#helloTimer) clearTimeout(this.#helloTimer);
    this.#helloTimer = null;
    const s = this.#deps.settings;
    const version = s.versions
      .filter((v) => m.d.versions.includes(v))
      .sort()
      .pop();
    if (!version) {
      this.#send({
        t: 'error',
        re: m.id,
        d: {
          code: 'unsupported_version',
          message: `the server speaks DEP ${s.versions.join(', ')}`,
          retryable: false,
          fatal: true,
          versions: [...s.versions],
        },
      });
      return this.#close(CLOSE.noVersion, 'no common protocol version');
    }
    let identity: VerifiedIdentity;
    try {
      identity = await this.#deps.verify(m.d.token);
    } catch (e) {
      return this.#refused(e, m.id);
    }
    if (this.#isClosed()) return;
    if (identity.expiresAt <= this.#deps.now())
      return this.#fatal('token_expired', 'the token has expired', m.id);
    if (!(await this.#originAllowed(identity.tenant)))
      return this.#fatal('forbidden', 'the origin is not allowed for this tenant', m.id);
    if (this.#isClosed()) return;
    // BE-091: the tenant's connection quota is checked before the session is open. A refused hello
    // is answered with `quota_exceeded` and `retryAfterMs`, and the connection closes.
    const admitted = this.#deps.quotas?.admitConnection(identity.tenant) ?? { ok: true as const };
    if (!admitted.ok) {
      const message = 'the tenant has reached its connection quota';
      return this.#fatalReply(
        {
          t: 'error',
          ...(m.id !== undefined ? { re: m.id } : {}),
          d: {
            code: 'quota_exceeded',
            message,
            retryable: true,
            retryAfterMs: admitted.retryAfterMs,
            fatal: true,
          },
        },
        closeCodeOf('quota_exceeded'),
      );
    }
    this.#connectionTenant = this.#deps.quotas ? identity.tenant : null;
    this.#identity = identity;
    this.#features = m.d.features;
    // 05 §5.1, §5.2 (SYN-046 criterion 4): every channel's engine must be one negotiated here.
    this.#engines = new SessionEngines(engineRegistry(s.engines));
    this.#engines.negotiate(m.d.engines);
    this.#state = 'open';
    this.#bucket = this.#deps.limits.connectionBucket(Date.now());
    // BE-087: the session's work belongs to the caller's trace when hello names one.
    const parent = parseTraceparent(m.d.traceparent);
    this.#span = this.#deps.tracer.start('dep.session', parent, {
      tenant: identity.tenant,
      session: this.id,
    });
    this.#trace = { traceId: this.#span.traceId, spanId: this.#span.spanId };
    this.#send({
      t: 'welcome',
      re: m.id,
      d: {
        version,
        session: this.id,
        user: this.#user(identity),
        features: [...s.features],
        limits: { ...s.limits },
        tokenExp: formatTimestamp(identity.expiresAt),
      },
    });
    this.#armToken(identity.expiresAt);
    this.#startHeartbeat();
    if (this.#draining) this.goaway(0);
  }

  /** The trace of the session, for tests and the composition (BE-087). */
  get trace(): TraceContext | null {
    return this.#trace;
  }

  /** The features the client announced in `hello`. */
  get features(): readonly string[] {
    return this.#features;
  }

  /**
   * The `Origin` header against the tenant's allowed origins (05 §4; 10 §3.2). A client that sends
   * none is not a browser and is accepted (ADR 0035).
   */
  async #originAllowed(tenant: string): Promise<boolean> {
    const lookup = this.#deps.allowedOrigins;
    if (!lookup || this.#origin === undefined) return true;
    try {
      return (await lookup(tenant)).includes(this.#origin);
    } catch (e) {
      this.#deps.settings.onError(e, 'origins');
      return false;
    }
  }

  #user(identity: VerifiedIdentity): { id: string; name?: string } {
    // The wire shows the host's `sub`; the surrogate stays at rest (D42; S6 gap G11). Without a
    // user lookup, commits can only show surrogates, so the session does too.
    const id = this.#deps.usersOnWire ? identity.sub : identity.connection.sub;
    return identity.name !== undefined ? { id, name: identity.name } : { id };
  }

  /** `auth.expiring` about 60 seconds before `tokenExp`; at `tokenExp`, 4401 (05 §5.1). */
  #armToken(expiresAt: number): void {
    if (this.#expiringTimer) clearTimeout(this.#expiringTimer);
    if (this.#expiryTimer) clearTimeout(this.#expiryTimer);
    const left = expiresAt - this.#deps.now();
    this.#expiringTimer = setTimeout(
      () => {
        this.#expiringTimer = null;
        this.#send({ t: 'auth.expiring', d: { inMs: Math.max(0, expiresAt - this.#deps.now()) } });
      },
      Math.max(0, Math.min(left - this.#deps.settings.authExpiringMs, 2 ** 31 - 1)),
    );
    this.#expiringTimer.unref?.();
    this.#expiryTimer = setTimeout(
      () => {
        this.#expiryTimer = null;
        this.#fatal('token_expired', 'the token expired');
      },
      Math.max(0, Math.min(left, 2 ** 31 - 1)),
    );
    this.#expiryTimer.unref?.();
  }

  /** 05 §4: `ping` after `heartbeatMs` without sending; silence for two intervals ends it. */
  #startHeartbeat(): void {
    const every = this.#deps.settings.limits.heartbeatMs;
    this.#heartbeat = setInterval(
      () => {
        const now = Date.now();
        if (now - this.#lastHeard > 2 * every) {
          // The peer is gone; a close frame would not reach it (ADR 0035).
          this.#ws.terminate();
          this.#ended();
          return;
        }
        if (now - this.#lastSent >= every) this.#send({ t: 'ping' });
      },
      Math.max(100, Math.floor(every / 2)),
    );
    this.#heartbeat.unref?.();
  }

  /** 05 §5.1, §3.1: a new token, for the session or for one channel (D07). */
  async #refresh(m: AuthRefreshMessage): Promise<void> {
    const channel = m.ch !== undefined ? this.#channels.get(m.ch) : undefined;
    if (m.ch !== undefined && !channel)
      return this.#error('bad_message', `channel ${m.ch} is not open`, m.id, m.ch);
    let identity: VerifiedIdentity;
    try {
      identity = await this.#deps.verify(m.d.token);
    } catch (e) {
      const code = socketCodeOf(e) ?? 'unauthenticated';
      return this.#error(code, 'the token was refused', m.id, m.ch);
    }
    const before = channel ? channel.identity : this.#identity!;
    // A refreshed token MUST carry the same tid and sub as the session (05 §3.1; BE-029).
    if (identity.tenant !== before.tenant || identity.sub !== before.sub)
      return this.#error('forbidden', 'the token is for another tenant or user', m.id, m.ch);
    if (identity.expiresAt <= this.#deps.now())
      return this.#error('token_expired', 'the token has expired', m.id, m.ch);
    this.#send({
      t: 'auth.ok',
      re: m.id,
      ...(m.ch !== undefined ? { ch: m.ch } : {}),
      d: { tokenExp: formatTimestamp(identity.expiresAt) },
    });
    if (channel) {
      channel.own = true;
      this.#armChannelToken(channel, identity.expiresAt);
      this.#rebind(channel, identity);
      return;
    }
    this.#identity = identity;
    this.#armToken(identity.expiresAt);
    for (const c of this.#channels.values()) if (!c.own) this.#rebind(c, identity);
  }

  /**
   * A channel's token changed (05 §3.1; 07 §9; PRM-021). The room computes the connection's access
   * again from the new role, groups and claims and sends `perm.changed` when it changed; a token
   * that gives no role in the document closes the channel as forbidden.
   */
  #rebind(c: SessionChannel, identity: VerifiedIdentity): void {
    c.identity = identity;
    // The refreshed token's assertions replace the earlier ones (PRO-015 criterion 3).
    c.asserted = recordAsserted(identity, this.#deps.now());
    if (c.state !== 'open' || !c.conn || !c.room) return;
    const role = roleIn(identity, c.doc);
    if (!role)
      return this.#serverClose(c, {
        code: 'forbidden',
        reason: 'the token gives no role in this document',
      });
    const conn: RoomConnection = {
      ...connectionOf(identity, role),
      session: this.id,
      jti: identity.jti,
    };
    c.conn = conn;
    // The room sends perm.changed only when access changed; later commits record the new jti.
    c.room.refresh(c.key, conn);
  }

  /** A channel token expires on its own; the channel closes (ADR 0035). */
  #armChannelToken(c: SessionChannel, expiresAt: number): void {
    if (c.expiry) clearTimeout(c.expiry);
    c.expiry = setTimeout(
      () => {
        c.expiry = null;
        if (this.#channels.get(c.ch) === c)
          this.#serverClose(c, { code: 'forbidden', reason: 'the token of the channel expired' });
      },
      Math.max(0, Math.min(expiresAt - this.#deps.now(), 2 ** 31 - 1)),
    );
    c.expiry.unref?.();
  }

  // --- Channels (05 §5.2) ----------------------------------------------------------------------

  async #openChannel(m: ChOpenMessage): Promise<void> {
    const s = this.#deps.settings;
    const d = m.d;
    const reject = (code: Refusal['code'], message: string) =>
      this.#send({ t: 'ch.rejected', re: m.id, ch: m.ch, d: { code, message } });
    if (this.#channels.has(m.ch)) return reject('already_open', `channel ${m.ch} is in use`);
    if ([...this.#channels.values()].some((c) => c.doc === d.doc))
      return reject('already_open', 'the document is open on another channel of this connection');
    if (this.#channels.size >= s.limits.maxChannels)
      return reject('channel_limit', `at most ${s.limits.maxChannels} channels per connection`);
    // SYN-046 criterion 4: registered, served by the room, and negotiated in this session's hello.
    const engine = this.#engines?.forChannel(d.engine);
    if (!engine?.ok)
      return reject('unsupported_engine', engine?.reason ?? `unknown engine ${d.engine}`);
    if (d.cdm < s.cdm.min || d.cdm > s.cdm.max)
      return reject('unsupported_cdm', `the server reads CDM ${s.cdm.min} to ${s.cdm.max}`);
    // 05 §1 rule 4 (D121): a client may use only the features the server announced.
    const unannounced = d.features.filter((f) => !s.features.includes(f));
    if (unannounced.length)
      return reject('unsupported_feature', `not announced: ${unannounced.join(', ')}`);
    if (this.#draining) return reject('unavailable', 'the node is draining');
    let identity = this.#identity!;
    let own = false;
    if (d.token !== undefined) {
      try {
        identity = await this.#deps.verify(d.token);
      } catch {
        return reject('forbidden', 'the token of the channel was refused');
      }
      if (identity.tenant !== this.#identity!.tenant || identity.sub !== this.#identity!.sub)
        return reject('forbidden', 'the token is for another tenant or user');
      own = true;
    }
    const role = roleIn(identity, d.doc);
    if (!role) return reject('forbidden', 'the token gives no role in this document');
    const c: SessionChannel = {
      ch: m.ch,
      doc: d.doc,
      key: `${this.id}#${m.ch}`,
      state: 'opening',
      room: null,
      identity,
      // Recorded as given when the token is accepted for the channel (PRO-015 criterion 3).
      asserted: recordAsserted(identity, this.#deps.now()),
      conn: null,
      own,
      expiry: null,
      features: [...d.features],
      span: this.#deps.tracer.start('dep.channel', this.#trace, {
        tenant: identity.tenant,
        doc: d.doc,
        session: this.id,
        ch: m.ch,
      }),
    };
    this.#channels.set(m.ch, c);
    const ref = { tenant: identity.tenant, doc: d.doc };
    try {
      const room = await this.#deps.host.acquire(ref);
      // 03 §11.1: a client that lacks a feature the document requires cannot open it.
      const decision = mayOpen(room.requires, d.features);
      if (!decision.ok)
        throw new Refusal(
          'unsupported_feature',
          `the document requires ${decision.missing.join(', ')}`,
        );
      if (room.record.cdmVersion !== d.cdm)
        throw new Refusal('unsupported_cdm', `the document is CDM ${room.record.cdmVersion}`);
      // The permission state in storage, so that a lost notification cannot let a reader in
      // under revoked access (ADR 0019 change 3).
      const stored = await this.#deps.grants.current(ref);
      if (this.#channels.get(m.ch) !== c || this.#state === 'closed') return;
      const conn: RoomConnection = {
        ...connectionOf(identity, role),
        // The session of the commits is this connection's (04 G6; 05 §5.1).
        session: this.id,
        jti: identity.jti,
      };
      c.conn = conn;
      c.room = room;
      room.open(c.key, this.#port(c, m.id), conn, d.resume, stored);
      c.state = 'open';
      if (own) this.#armChannelToken(c, identity.expiresAt);
    } catch (e) {
      if (this.#channels.get(m.ch) === c) this.#channels.delete(m.ch);
      if (!(e instanceof Refusal)) this.#deps.settings.onError(e, 'ch.open');
      const r =
        e instanceof Refusal ? e : new Refusal('unavailable', 'the document could not be opened');
      c.span?.end({ outcome: 'rejected', code: r.code });
      c.span = null;
      if (this.#state !== 'closed') reject(r.code, r.message);
    }
  }

  #port(c: SessionChannel, openId: string): ChannelPort {
    const identity = c.identity;
    return {
      session: this.id,
      user: this.#user(identity),
      wantsPresence:
        this.#features.includes('presence') && this.#deps.settings.features.includes('presence'),
      features: c.features,
      trace: c.span ? { traceId: c.span.traceId, spanId: c.span.spanId } : this.#trace,
      opened: (d) => this.#send({ t: 'ch.opened', re: openId, ch: c.ch, d }),
      send: (e, re) =>
        this.#send({
          t: e.t,
          ch: c.ch,
          ...(re !== undefined ? { re } : {}),
          d: e.d,
        } as ServerMessage),
      presence: (p) => this.#send({ t: 'presence.state', ch: c.ch, d: p }),
      event: (n) => this.#send({ t: 'event', ch: c.ch, d: n }),
      check: (d) => this.#send({ t: 'sync.check', ch: c.ch, d }),
      closed: (d, cause) => {
        if (this.#channels.get(c.ch) !== c) return;
        this.#forget(c);
        // A change of access is told apart from a room that moved (G103; decision D42).
        const wire: ChannelClosed & { cause?: string } =
          cause === 'access_changed' ? { ...d, cause } : d;
        this.#send({ t: 'ch.closed', ch: c.ch, d: wire });
      },
    };
  }

  #closeChannel(m: ChCloseMessage): void {
    const c = this.#channels.get(m.ch);
    if (!c) return;
    this.#forget(c);
    c.room?.close(c.key);
  }

  /** The server closes a channel itself. */
  #serverClose(c: SessionChannel, d: ChannelClosed): void {
    this.#forget(c);
    c.room?.close(c.key);
    this.#send({ t: 'ch.closed', ch: c.ch, d });
  }

  #forget(c: SessionChannel): void {
    if (this.#channels.get(c.ch) === c) this.#channels.delete(c.ch);
    if (c.expiry) clearTimeout(c.expiry);
    c.expiry = null;
    c.span?.end({ outcome: 'closed' });
    c.span = null;
  }

  #submit(m: SyncSubmitMessage): void {
    const c = this.#channels.get(m.ch);
    if (!c || c.state !== 'open' || !c.room)
      return this.#error('bad_message', `channel ${m.ch} is not open`, m.id, m.ch);
    c.room.submit(c.key, m.d, m.id);
  }

  #presence(m: PresenceUpdateMessage): void {
    if (!this.#deps.settings.features.includes('presence')) return;
    const c = this.#channels.get(m.ch);
    if (c?.state === 'open') c.room?.presence(c.key, m.d);
  }

  // --- Revocation (05 §3.3) --------------------------------------------------------------------

  /** The host revoked a user's sessions: of the whole tenant, or on one document. */
  revoked(tenant: string, user: string, doc: string | null): void {
    const id = this.#identity;
    if (!id || id.tenant !== tenant || this.#state !== 'open') return;
    if (doc === null) {
      if (id.connection.sub !== user) return;
      this.#send({ t: 'auth.revoked', d: { reason: 'the host revoked the session' } });
      return this.#close(CLOSE.unauthenticated, 'revoked');
    }
    for (const c of [...this.#channels.values()])
      if (c.doc === doc && c.conn?.sub === user)
        this.#serverClose(c, {
          code: 'forbidden',
          reason: 'the host revoked access to the document',
        });
  }

  /** The node drains: no new channels from now on (BE-022). */
  draining(): void {
    this.#draining = true;
  }

  /** The service drains (06 §2.2 step 5): `goaway` with a jittered hint, then 4503. */
  goaway(reconnectInMs: number): void {
    if (this.#state === 'closed') return;
    if (this.#state === 'open')
      this.#send({ t: 'goaway', d: { reconnectInMs, reason: 'the service is restarting' } });
    // The goaway must reach the client before the close frame: send what is queued first.
    this.#close(CLOSE.unavailable, 'draining');
  }

  // --- Sending and closing ---------------------------------------------------------------------

  #send(msg: ServerMessage | ErrorMessage): void {
    if (this.#state === 'closed' || this.#ws.readyState !== this.#ws.OPEN) return;
    let text: string;
    try {
      text = codec.encode(msg);
    } catch (e) {
      // The server built an invalid message: a defect. Close rather than leave the client stuck.
      this.#deps.settings.onError(e, `encode ${msg.t}`);
      this.#close(CLOSE.internal, 'internal error');
      return;
    }
    const max = this.#state === 'open' ? this.#deps.settings.limits.maxMessageBytes : Infinity;
    const frames = utf8Length(text) > max ? chunkMessage(text, max, uuid7()) : [text];
    const bytes = frames.reduce((a, f) => a + utf8Length(f), 0);
    // A channel's own messages may be dropped for a slow consumer; ch.closed never is.
    const ch =
      typeof (msg as { ch?: unknown }).ch === 'number' && msg.t !== 'ch.closed'
        ? ((msg as { ch: number }).ch as number)
        : null;
    const waits = this.#out.length > 0 || this.#inFlight >= this.#deps.settings.socketHighWater;
    if (waits && ch !== null) {
      const queued = (this.#waiting.get(ch) ?? 0) + bytes;
      if (queued > this.#deps.settings.sendQueueBytes && this.#channels.has(ch)) {
        this.#slowConsumer(ch);
        return;
      }
      this.#waiting.set(ch, queued);
    }
    this.#out.push({ ch: waits ? ch : null, frames, bytes });
    this.#pump();
  }

  /** Hands queued messages to the socket while less than the high-water mark is unflushed. */
  #pump(): void {
    while (this.#out.length && this.#inFlight < this.#deps.settings.socketHighWater) {
      if (this.#ws.readyState !== this.#ws.OPEN) {
        this.#out = [];
        this.#waiting.clear();
        return;
      }
      const e = this.#out.shift()!;
      if (e.ch !== null) {
        const left = (this.#waiting.get(e.ch) ?? 0) - e.bytes;
        if (left > 0) this.#waiting.set(e.ch, left);
        else this.#waiting.delete(e.ch);
      }
      for (const f of e.frames) {
        const n = utf8Length(f);
        this.#inFlight += n;
        this.#ws.send(f, () => {
          this.#inFlight -= n;
          this.#pump();
        });
      }
      this.#lastSent = Date.now();
    }
  }

  /**
   * A channel's queue passed its bound (06 §2.4; BE-027): its waiting messages are dropped, the
   * room forgets it, and the client is told `slow_consumer`; it resumes from its last `seq`.
   */
  #slowConsumer(ch: number): void {
    this.#out = this.#out.filter((e) => e.ch !== ch);
    this.#waiting.delete(ch);
    const c = this.#channels.get(ch);
    if (c) {
      this.#forget(c);
      c.room?.close(c.key);
      // A channel exists only after `hello`, so it always has a verified tenant (BE-086).
      this.#deps.metrics.slowConsumers.inc({ tenant: c.identity.tenant });
    }
    this.#send({
      t: 'ch.closed',
      ch,
      d: { code: 'slow_consumer', reason: 'the channel fell behind; resume it from its last seq' },
    });
  }

  #error(code: SocketErrorCode, message: string, re?: string, ch?: number): void {
    this.#send({
      t: 'error',
      ...(re !== undefined ? { re } : {}),
      ...(ch !== undefined ? { ch } : {}),
      d: { code, message, retryable: retryable(code), fatal: false },
    });
  }

  /** A fatal `error`, then the close code it implies (05 §5.7; D25). */
  #fatal(code: SocketErrorCode, message: string, re?: string): void {
    if (this.#state === 'closed') return;
    this.#send({
      t: 'error',
      ...(re !== undefined ? { re } : {}),
      d: { code, message, retryable: retryable(code), fatal: true },
    });
    this.#close(closeCodeOf(code), message);
  }

  #fatalReply(reply: ErrorMessage, close: number): void {
    this.#send({ ...reply, d: { ...reply.d, fatal: true } });
    this.#close(close, reply.d.message);
  }

  /** Verification failed: the registry code of the error, or `unauthenticated` (fail closed). */
  #refused(e: unknown, re: string): void {
    const code = socketCodeOf(e);
    if (!code) this.#deps.settings.onError(e, 'verify');
    this.#fatal(code ?? 'unauthenticated', 'the token was refused', re);
  }

  #close(code: number, reason: string): void {
    if (this.#state === 'closed') return;
    this.#state = 'closed';
    // What is queued for the client goes out before the close frame (ws sends in order).
    const queued = this.#out;
    this.#out = [];
    this.#waiting.clear();
    if (this.#ws.readyState === this.#ws.OPEN)
      for (const e of queued) for (const f of e.frames) this.#ws.send(f);
    // A close reason is at most 123 bytes; keep it short and never echo client input.
    this.#ws.close(code, Buffer.from(reason, 'utf8').subarray(0, 120).toString('utf8'));
    this.#ended();
  }

  #ended(): void {
    this.#state = 'closed';
    if (this.#done) return;
    this.#done = true;
    if (this.#connectionTenant !== null) {
      this.#deps.quotas?.releaseConnection(this.#connectionTenant);
      this.#connectionTenant = null;
    }
    // Only an identified connection has a tenant to count its time under (BE-085).
    if (this.#identity)
      this.#deps.metrics.connectionSeconds.inc(
        { tenant: this.#identity.tenant },
        (this.#deps.now() - this.#connectedAt) / 1000,
      );
    for (const t of [this.#helloTimer, this.#expiringTimer, this.#expiryTimer])
      if (t) clearTimeout(t);
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#helloTimer = this.#expiringTimer = this.#expiryTimer = null;
    this.#heartbeat = null;
    this.#out = [];
    this.#waiting.clear();
    const channels = [...this.#channels.values()];
    this.#channels.clear();
    for (const c of channels) {
      if (c.expiry) clearTimeout(c.expiry);
      c.span?.end({ outcome: 'ended' });
      c.room?.close(c.key);
    }
    this.#span?.end({ channels: channels.length });
    this.#deps.ended(this);
  }
}
