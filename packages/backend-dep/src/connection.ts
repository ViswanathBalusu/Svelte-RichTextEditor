/**
 * One WebSocket to the document service (05 §4) with its ClientSession: opening with the
 * subprotocol `dep.v1`, the handshake, the heartbeat, and the end of the connection. The backend
 * makes a new one for every session; there is no session resumption (05 §5.1).
 */
import {
  PortError,
  definition,
  type ClientMessage,
  type ErrorPayload,
  type ServerMessage,
  type Welcome,
} from '@docedit/protocol';
import {
  ClientSession,
  classifyClose,
  type CloseVerdict,
  type SessionOptions,
} from '@docedit/protocol/client';
import type { Platform, Timers, WebSocketLike } from './platform.ts';

export interface ConnectionHooks {
  /** `welcome` arrived: the session is open. Called before any later frame is read. */
  welcome(conn: Connection, welcome: Welcome, features: readonly string[]): void;
  /** The connection ended before `welcome`: the socket failed or closed, the server refused, or no answer came. */
  failed(conn: Connection, error: PortError): void;
  /** A message after `welcome` that the session passes on. */
  message(conn: Connection, m: ServerMessage): void;
  /** The connection ended after `welcome`, by either side. */
  closed(conn: Connection, verdict: CloseVerdict, reason: string): void;
}

export type HelloSettings = Omit<SessionOptions, 'now'>;

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The PortError for an `error` that refused the session. */
export function refusal(e: ErrorPayload): PortError {
  return new PortError(e.code, e.message, {
    ...(e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {}),
    details: { ...e },
  });
}

export class Connection {
  private readonly p: Platform;
  private readonly timers: Timers;
  private readonly hooks: ConnectionHooks;
  private socket: WebSocketLike | null = null;
  private session: ClientSession | null = null;
  private phase: 'opening' | 'handshaking' | 'ready' | 'closed' = 'opening';
  /** The handshake timeout, then the heartbeat. */
  private timer: number | null = null;

  constructor(p: Platform, timers: Timers, hooks: ConnectionHooks) {
    this.p = p;
    this.timers = timers;
    this.hooks = hooks;
  }

  get ready(): boolean {
    return this.phase === 'ready';
  }

  /** What the session repaired or ignored, for diagnostics. */
  get faults(): ClientSession['faults'] | null {
    return this.session?.faults ?? null;
  }

  /** Opens the socket and runs `hello`; the outcome arrives through the hooks. */
  start(url: string, hello: HelloSettings, answerTimeoutMs: number): void {
    this.timer = this.timers.set(() => {
      this.timer = null;
      this.fail(new PortError('unavailable', `no welcome within ${answerTimeoutMs} ms`));
    }, answerTimeoutMs);
    let socket: WebSocketLike;
    try {
      socket = new this.p.WebSocket(url, [definition.SUBPROTOCOL]);
    } catch (e) {
      this.fail(new PortError('unavailable', `cannot open ${url}: ${messageOf(e)}`));
      return;
    }
    this.socket = socket;
    socket.addEventListener('open', () => this.onOpen(hello));
    socket.addEventListener('message', (e) => this.onMessage(e.data));
    socket.addEventListener('close', (e) => this.onClose(e.code, e.reason));
    socket.addEventListener('error', () => {
      // A close event follows; it carries the code.
    });
  }

  /** Sends a message; throws a FrameError for an invalid one. Ignored once the connection ended. */
  send(message: ClientMessage): void {
    if (this.phase !== 'ready' || !this.session) return;
    this.session.send(message, this.p.now());
    this.flush();
  }

  /**
   * Closes the connection from this side. `verdict` reports it through `closed` (the heartbeat
   * found it dead, or a frame could not be read); without one nothing is reported.
   */
  close(code: number, reason: string, verdict?: CloseVerdict): void {
    if (this.phase === 'closed') return;
    const wasReady = this.phase === 'ready';
    this.finish();
    try {
      this.socket?.close(code, reason);
    } catch {
      // The socket is already closing.
    }
    if (!wasReady) this.hooks.failed(this, new PortError(verdict?.code ?? 'unavailable', reason));
    else if (verdict) this.hooks.closed(this, verdict, reason);
  }

  private onOpen(hello: HelloSettings): void {
    if (this.phase !== 'opening' || !this.socket) return;
    if (this.socket.protocol !== definition.SUBPROTOCOL) {
      this.fail(
        new PortError(
          'unsupported_version',
          `the server selected the subprotocol "${this.socket.protocol}", not ${definition.SUBPROTOCOL} (05 §4)`,
        ),
      );
      return;
    }
    this.phase = 'handshaking';
    this.session = new ClientSession({ ...hello, now: this.p.now() });
    this.flush();
  }

  private onMessage(data: unknown): void {
    // Binary frames are for engines with opaque payloads; `pm-steps/1` uses none (05 §4; G15).
    if (typeof data !== 'string' || !this.session) return;
    if (this.phase !== 'handshaking' && this.phase !== 'ready') return;
    for (const input of this.session.receive(data, this.p.now())) {
      // A hook may have closed the connection meanwhile.
      if (this.isClosed()) return;
      switch (input.kind) {
        case 'welcome':
          this.phase = 'ready';
          this.timers.clear(this.timer);
          this.timer = null;
          this.hooks.welcome(this, input.welcome, input.features);
          break;
        case 'refused':
          this.fail(refusal(input.error));
          return;
        case 'fatal':
          this.close(input.close, input.reason, { code: 'bad_message', reconnect: 'no' });
          return;
        case 'message':
          if (this.phase === 'ready') this.hooks.message(this, input.message);
          break;
      }
    }
    this.flush();
  }

  private onClose(code: number, reason: string): void {
    if (this.phase === 'closed') return;
    const wasReady = this.phase === 'ready';
    const lastFatal = this.session?.lastFatal ?? null;
    this.finish();
    const verdict = classifyClose(code, lastFatal);
    const text = reason ? `${code}: ${reason}` : `${code}`;
    if (wasReady) this.hooks.closed(this, verdict, `the connection closed (${text})`);
    else
      this.hooks.failed(
        this,
        lastFatal
          ? refusal(lastFatal)
          : new PortError(verdict.code, `the connection closed before welcome (${text})`, {
              ...(verdict.retryAfterMs !== undefined ? { retryAfterMs: verdict.retryAfterMs } : {}),
            }),
      );
  }

  /** Ends the handshake with an error and closes the socket. */
  private fail(error: PortError): void {
    if (this.phase === 'closed' || this.phase === 'ready') return;
    this.finish();
    try {
      this.socket?.close(1000, 'handshake failed');
    } catch {
      // The socket is already closing.
    }
    this.hooks.failed(this, error);
  }

  private isClosed(): boolean {
    return this.phase === 'closed';
  }

  private finish(): void {
    this.phase = 'closed';
    this.session?.end();
    this.timers.clear(this.timer);
    this.timer = null;
  }

  private flush(): void {
    if (!this.session || !this.socket) return;
    for (const frame of this.session.take()) {
      try {
        this.socket.send(frame);
      } catch {
        // The socket closed under us; its close event ends the connection.
        return;
      }
    }
    this.arm();
  }

  /** Arms the heartbeat for the session's next deadline (05 §4). Deadlines only move later. */
  private arm(): void {
    if (this.phase !== 'ready' || !this.session || this.timer !== null) return;
    const wait = this.session.deadline() - this.p.now();
    this.timer = this.timers.set(() => {
      this.timer = null;
      this.beat();
    }, wait);
  }

  private beat(): void {
    if (this.phase !== 'ready' || !this.session) return;
    if (this.session.tick(this.p.now()) === 'dead') {
      this.close(1000, 'nothing heard for two heartbeat intervals', {
        code: 'unavailable',
        reconnect: 'backoff',
      });
      return;
    }
    this.flush();
    this.arm();
  }
}
