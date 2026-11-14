/**
 * The client side of one DEP connection (05 §4, §5.1; PRO-004, PRO-005, PRO-006): `hello` and
 * `welcome`, the frames in between and after, the heartbeat and chunks. It does no I/O: the caller
 * passes each received text frame in, writes the frames the machine queues (take()), and passes the
 * time in, so the machine behaves the same under a real clock and a virtual one.
 *
 * Handled here, so that no caller can get them wrong:
 * - unknown message types are ignored, and answered with `error` `unknown_type`, `fatal: false`,
 *   when they carry an `id` (05 §1 rule 3); `x-` types are unknown unless defined (rule 5);
 * - a known type with an invalid payload is answered with a non-fatal `bad_message`; a frame that
 *   is not a JSON object with a type closes the socket with 4400 (D03);
 * - unknown members are ignored (the codec validates only what it knows);
 * - `welcome` must answer this connection's `hello` with a version the client offered; the
 *   features the client may use are those it asked for that the server announced (05 §1 rule 4);
 * - `ping` is answered with `pong`; `ping` is sent after `heartbeatMs` without sending, and the
 *   connection is dead after two intervals without hearing anything (05 §4);
 * - `chunk` frames are reassembled, and an outgoing message above `maxMessageBytes` is chunked.
 */
import { uuid7 } from '@docedit/model';
import { Reassembler, chunkMessage } from '../codec/chunk.ts';
import { depCodec, utf8Length, type FrameCodec } from '../codec/frame.ts';
import { DEP1 } from '../definition/index.ts';
import type {
  CdmRange,
  Chunk,
  ClientInfo,
  ClientMessage,
  ErrorPayload,
  Hello,
  Limits,
  ServerMessage,
  Welcome,
  WelcomeMessage,
} from '../generated/types.ts';
import { negotiateFeatures } from './negotiate.ts';

/** 05 §4: `ping` after 25,000 ms without sending, until `welcome` says otherwise. */
export const DEFAULT_HEARTBEAT_MS = 25_000;

export interface SessionOptions {
  /** The user token for `hello` (05 §3.1). */
  token: string;
  client: ClientInfo;
  /** Features the client asks for (05 §1 rule 4). */
  features: readonly string[];
  /** Protocol versions the client supports (default: the definition's, `1.0`). */
  versions?: readonly string[];
  engines?: readonly string[];
  cdm?: CdmRange;
  traceparent?: string;
  /** Envelope identifiers for messages that expect a reply, unique on the connection. */
  ids: () => string;
  /** When the socket opened, Unix milliseconds. */
  now: number;
  codec?: FrameCodec;
  /** Identifiers of chunked messages (`chunk.of`; D04: a UUID version 7). */
  chunkIds?: () => string;
}

export type SessionPhase = 'handshaking' | 'ready' | 'ended';

/** What a received frame means for the caller. */
export type SessionInput =
  /** The session is open; `features` is what the client may use. */
  | { kind: 'welcome'; welcome: Welcome; features: readonly string[] }
  /** The server refused the session (`error` before `welcome`), or chose a version the client did not offer. */
  | { kind: 'refused'; error: ErrorPayload }
  /** Everything else the caller acts on: channel-scoped messages, replies, `auth.*`, `goaway`, `error`. */
  | { kind: 'message'; message: ServerMessage }
  /** The frame cannot be read: close the socket with 4400 (05 §5.7; D03). */
  | { kind: 'fatal'; close: 4400; reason: string };

export class ClientSession {
  phase: SessionPhase = 'handshaking';
  readonly helloId: string;
  welcome: Welcome | null = null;
  /** The features the client may use: asked for and announced. Empty until `welcome`. */
  features: readonly string[] = [];
  /** The last fatal `error` the server sent; the close that follows refers to it (05 §5.7). */
  lastFatal: ErrorPayload | null = null;
  /** What the machine ignored or repaired, for diagnostics and tests. */
  readonly faults = { unknown: 0, invalid: 0, chunks: 0 };

  private readonly codec: FrameCodec;
  private readonly offered: readonly string[];
  private readonly requested: readonly string[];
  private readonly chunkIds: () => string;
  private readonly reassembler = new Reassembler();
  private readonly queue: string[] = [];
  private lastSent: number;
  private lastReceived: number;
  private heartbeat = DEFAULT_HEARTBEAT_MS;

  constructor(opts: SessionOptions) {
    this.codec = opts.codec ?? depCodec();
    this.offered = [...(opts.versions ?? [DEP1.version])];
    this.requested = negotiateFeatures(opts.features, opts.features);
    this.chunkIds = opts.chunkIds ?? uuid7;
    this.lastSent = opts.now;
    this.lastReceived = opts.now;
    this.helloId = opts.ids();
    const d: Hello = {
      versions: [...this.offered],
      token: opts.token,
      client: { name: opts.client.name, version: opts.client.version },
      engines: [...(opts.engines ?? DEP1.engines)],
      cdm: { ...(opts.cdm ?? DEP1.cdm) },
      features: [...this.requested],
    };
    if (opts.traceparent !== undefined) d.traceparent = opts.traceparent;
    // `hello` is the first message (05 §5.1).
    this.send({ t: 'hello', id: this.helloId, d }, opts.now);
  }

  get limits(): Limits | null {
    return this.welcome?.limits ?? null;
  }

  get heartbeatMs(): number {
    return this.heartbeat;
  }

  /** Takes the frames queued for the socket, in order. */
  take(): string[] {
    return this.queue.splice(0);
  }

  /**
   * Queues a message, cut into `chunk` frames when it exceeds `maxMessageBytes` (05 §4; D04).
   * Throws a FrameError for an invalid message: nothing invalid leaves the client.
   */
  send(message: ClientMessage, now: number): void {
    const text = this.codec.encode(message);
    const max = this.welcome?.limits.maxMessageBytes;
    if (max !== undefined && utf8Length(text) > max)
      this.queue.push(...chunkMessage(text, max, this.chunkIds()));
    else this.queue.push(text);
    this.lastSent = now;
  }

  /** Reads one received text frame. */
  receive(text: string, now: number): SessionInput[] {
    this.lastReceived = now;
    if (this.phase === 'ended') return [];
    return this.read(text, now, false);
  }

  /** The socket closed: nothing more is read. */
  end(): void {
    this.phase = 'ended';
  }

  /**
   * Heartbeat (05 §4): queues `ping` after `heartbeatMs` without sending; `dead` once nothing was
   * heard for two intervals, when the caller closes the connection. Expires a stale reassembly.
   */
  tick(now: number): 'ok' | 'dead' {
    if (this.phase === 'ended') return 'ok';
    if (this.reassembler.expire(now) !== null) this.faults.chunks++;
    if (now - this.lastReceived >= 2 * this.heartbeat) return 'dead';
    if (this.phase === 'ready' && now - this.lastSent >= this.heartbeat)
      this.send({ t: 'ping' }, now);
    return 'ok';
  }

  /** When tick() next has something to do. */
  deadline(): number {
    const dead = this.lastReceived + 2 * this.heartbeat;
    return this.phase === 'ready' ? Math.min(dead, this.lastSent + this.heartbeat) : dead;
  }

  private read(text: string, now: number, inChunk: boolean): SessionInput[] {
    const r = this.codec.decode(text, { receiver: 'client' });
    switch (r.kind) {
      case 'unknown':
        this.faults.unknown++;
        if (r.reply) this.send(r.reply, now);
        return [];
      case 'invalid':
        this.faults.invalid++;
        if (r.fatal) return [{ kind: 'fatal', close: 4400, reason: r.reason }];
        this.send(r.reply, now);
        return [];
      case 'message': {
        const m = r.message as ServerMessage;
        if (inChunk && m.t === 'chunk') {
          // A chunk cannot carry chunks (D04).
          this.faults.chunks++;
          return [];
        }
        return this.message(m, now);
      }
    }
  }

  private message(m: ServerMessage, now: number): SessionInput[] {
    switch (m.t) {
      case 'ping':
        this.send(m.id !== undefined ? { t: 'pong', re: m.id } : { t: 'pong' }, now);
        return [];
      case 'pong':
        return [];
      case 'chunk':
        return this.chunk(m.d, now);
      case 'welcome':
        return this.onWelcome(m);
      case 'error':
        if (m.d.fatal) this.lastFatal = m.d;
        // Before `welcome` the only request is `hello`, so any error refuses the session.
        if (this.phase === 'handshaking') {
          this.phase = 'ended';
          return [{ kind: 'refused', error: m.d }];
        }
        return [{ kind: 'message', message: m }];
      default:
        // Nothing but `welcome` or `error` is expected before `welcome`.
        if (this.phase !== 'ready') return [];
        return [{ kind: 'message', message: m }];
    }
  }

  private onWelcome(m: WelcomeMessage): SessionInput[] {
    if (this.phase !== 'handshaking' || m.re !== this.helloId) return [];
    if (!this.offered.includes(m.d.version)) {
      this.phase = 'ended';
      return [
        {
          kind: 'refused',
          error: {
            code: 'unsupported_version',
            message: `the server chose version ${m.d.version}, which this client did not offer (${this.offered.join(', ')})`,
            retryable: false,
            fatal: true,
          },
        },
      ];
    }
    this.welcome = m.d;
    this.phase = 'ready';
    if (m.d.limits.heartbeatMs > 0) this.heartbeat = m.d.limits.heartbeatMs;
    this.features = negotiateFeatures(this.requested, m.d.features);
    return [{ kind: 'welcome', welcome: m.d, features: this.features }];
  }

  private chunk(d: Chunk, now: number): SessionInput[] {
    const r = this.reassembler.push(d, now);
    if (r.status === 'partial') return [];
    if (r.status === 'error') {
      // What follows a broken reassembly is not stated (G14): the message is lost, and the
      // channel's gap detection recovers what it carried.
      this.faults.chunks++;
      return [];
    }
    return this.read(r.text, now, true);
  }
}
