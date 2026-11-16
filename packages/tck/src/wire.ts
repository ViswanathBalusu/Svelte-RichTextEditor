/**
 * The kit's side of the real-time plane (05 §4, §5): one WebSocket, frames encoded and decoded with
 * the protocol package's codec only. It is not a client library: it sends whatever a scenario asks,
 * valid or not, and it records every frame the server sends, so that a scenario can check order,
 * envelopes and close codes. Every frame from the server is decoded as a client would; a frame that
 * does not decode as a valid message is recorded as a problem of the server.
 */
import { Reassembler, depCodec, type DecodeResult, type ServerMessage } from '@docedit/protocol';
import WebSocket from 'ws';
import { KitFailure, show } from './assert.ts';
import { messageProblems } from './registry-oracle.ts';

const codec = depCodec();

export const SUBPROTOCOL = 'dep.v1';

export interface WireOptions {
  /** The `Origin` header; none by default (a client that is not a browser, ADR 0035). */
  origin?: string;
  /** Subprotocols offered (default `dep.v1`). */
  protocols?: readonly string[];
  /** How long to wait for the connection (default 10 s). */
  connectTimeoutMs?: number;
  /** The default wait for a message (default 10 s). */
  timeoutMs?: number;
  /** Sees every frame in both directions, for the coverage and leak oracles. */
  observe?: (direction: 'in' | 'out', text: string, wire: Wire) => void;
  /** Answers the server's `ping` with `pong`, as a client does (05 §4; default true). */
  autoPong?: boolean;
  /** A label for reports. */
  label?: string;
}

/** A frame received from the server, decoded. */
export interface Received {
  readonly at: number;
  readonly text: string;
  readonly result: DecodeResult;
}

export interface Closed {
  readonly code: number;
  readonly reason: string;
  readonly at: number;
}

/** Thrown by `connect` when the server answers the upgrade with something else than 101. */
export class UpgradeRefused extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`the server refused the WebSocket upgrade with HTTP ${status}`);
    this.name = 'UpgradeRefused';
    this.status = status;
  }
}

type Waiter = () => void;

export class Wire {
  readonly url: string;
  readonly label: string;
  /** Every frame received, in order. */
  readonly frames: Received[] = [];
  /** Every valid message received, in order, chunked messages reassembled. */
  readonly messages: ServerMessage[] = [];
  /** Frames from the server that are not valid DEP messages: defects of the server. */
  readonly problems: string[] = [];
  /** Message types received that the kit does not know (allowed by 05 §1 rule 3). */
  readonly unknown: string[] = [];
  /** Texts sent, in order. */
  readonly sent: string[] = [];
  closed: Closed | null = null;
  /**
   * Whether the server ended the connection: it closed before the kit asked for a close or dropped
   * the connection itself. Only such an end is held against 05 §5.7 (PRO-037).
   */
  endedByServer = false;
  /**
   * Close codes outside 05 §5.7 that the scenario accepts on this connection, because the
   * specification names no code for what it provokes (a silent peer, 05 §4).
   */
  readonly toleratedCloses = new Set<number>();
  private ending = false;
  /** The subprotocol the server selected. */
  protocol = '';
  private readonly ws: WebSocket;
  private readonly opts: WireOptions;
  private readonly waiters = new Set<Waiter>();
  private readonly reassembler = new Reassembler();
  private serial = 0;

  private constructor(url: string, ws: WebSocket, opts: WireOptions) {
    this.url = url;
    this.ws = ws;
    this.opts = opts;
    this.label = opts.label ?? 'wire';
  }

  /** Opens a WebSocket to `url` with the DEP subprotocol (05 §4). */
  static connect(url: string, opts: WireOptions = {}): Promise<Wire> {
    const ws = new WebSocket(url, [...(opts.protocols ?? [SUBPROTOCOL])], {
      ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
      handshakeTimeout: opts.connectTimeoutMs ?? 10_000,
      perMessageDeflate: false,
    });
    const wire = new Wire(url, ws, opts);
    return new Promise<Wire>((resolve, reject) => {
      let settled = false;
      ws.on('unexpected-response', (_req, res) => {
        settled = true;
        reject(new UpgradeRefused(res.statusCode ?? 0));
        ws.terminate();
      });
      ws.on('open', () => {
        settled = true;
        wire.protocol = ws.protocol;
        resolve(wire);
      });
      ws.on('error', (e) => {
        if (!settled) {
          settled = true;
          reject(e);
        }
      });
      ws.on('message', (data, isBinary) => wire.receive(data, isBinary));
      ws.on('close', (code, reason) => {
        wire.closed = { code, reason: reason.toString('utf8'), at: Date.now() };
        wire.endedByServer = !wire.ending;
        if (!settled) {
          settled = true;
          reject(new Error(`the connection closed before it opened (${code})`));
        }
        wire.wake();
      });
    });
  }

  get open(): boolean {
    return this.closed === null && this.ws.readyState === WebSocket.OPEN;
  }

  /** A fresh envelope `id`. */
  nextId(prefix = 'k'): string {
    this.serial += 1;
    return `${prefix}${this.serial}`;
  }

  /** The number of messages received so far, to wait for later ones. */
  mark(): number {
    return this.messages.length;
  }

  private receive(data: WebSocket.RawData, isBinary: boolean): void {
    if (isBinary) {
      this.problems.push('a binary frame: pm-steps/1 uses none (05 §4)');
      this.wake();
      return;
    }
    const buf = Array.isArray(data)
      ? Buffer.concat(data)
      : data instanceof ArrayBuffer
        ? Buffer.from(data)
        : data;
    const text = buf.toString('utf8');
    this.opts.observe?.('in', text, this);
    const result = codec.decode(text, { receiver: 'client' });
    this.frames.push({ at: Date.now(), text, result });
    this.accept(result, text);
    this.wake();
  }

  private accept(result: DecodeResult, text: string): void {
    if (result.kind === 'unknown') {
      this.unknown.push(result.t);
      return;
    }
    if (result.kind === 'invalid') {
      this.problems.push(
        `${result.reason}: ${result.violations.map((v) => `${v.path} ${v.message}`).join('; ')} in ${show(text)}`,
      );
      return;
    }
    const m = result.message as ServerMessage;
    if (m.t === 'ping' && this.opts.autoPong !== false && this.open)
      this.sendText(JSON.stringify(m.id !== undefined ? { t: 'pong', re: m.id } : { t: 'pong' }));
    if (m.t === 'chunk') {
      const r = this.reassembler.push(m.d, Date.now());
      if (r.status === 'error') this.problems.push(`chunk reassembly: ${r.reason}`);
      if (r.status === 'complete') {
        const inner = codec.decode(r.text, { receiver: 'client' });
        if (inner.kind === 'message' && inner.message.t === 'chunk')
          this.problems.push('a chunk inside a chunked message');
        else this.accept(inner, r.text);
      }
      return;
    }
    // A problem outside the error registry, or without its retry hint, is a defect of the server
    // (PRO-038); the message is still handed to the scenario.
    this.problems.push(...messageProblems(m));
    this.messages.push(m);
  }

  private wake(): void {
    for (const w of [...this.waiters]) w();
  }

  /** Sends a text frame as it is, valid or not. */
  sendText(text: string): void {
    this.sent.push(text);
    this.opts.observe?.('out', text, this);
    this.ws.send(text);
  }

  /** Sends a binary frame (05 §4 reserves them for engines with opaque payloads). */
  sendBinary(bytes: Uint8Array): void {
    this.ws.send(bytes, { binary: true });
  }

  /** Sends a message object, encoded without validation (scenarios send invalid frames on purpose). */
  send(message: Record<string, unknown>): string {
    const text = codec.encode(message, { validate: false });
    this.sendText(text);
    return text;
  }

  /** Waits until `pred` holds or the connection closes; resolves whether it held. */
  private wait(pred: () => boolean, timeoutMs: number): Promise<boolean> {
    if (pred()) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const done = (ok: boolean) => {
        this.waiters.delete(waiter);
        clearTimeout(timer);
        resolve(ok);
      };
      const waiter = () => {
        if (pred()) done(true);
        else if (this.closed) done(pred());
      };
      const timer = setTimeout(() => done(pred()), timeoutMs);
      this.waiters.add(waiter);
    });
  }

  private timeout(ms?: number): number {
    return ms ?? this.opts.timeoutMs ?? 10_000;
  }

  /** The first message at index `from` or later that satisfies `pred`, or a failure. */
  async next<T extends ServerMessage = ServerMessage>(
    pred: (m: ServerMessage) => boolean,
    what: string,
    opts: { from?: number; timeoutMs?: number } = {},
  ): Promise<T> {
    const from = opts.from ?? 0;
    const find = () => this.messages.slice(from).find(pred);
    await this.wait(() => find() !== undefined, this.timeout(opts.timeoutMs));
    const found = find();
    if (found) return found as T;
    throw new KitFailure(
      `${this.label}: timed out waiting for ${what}`,
      what,
      this.closed
        ? `the connection closed with ${this.closed.code} (${this.closed.reason}); received ${this.summary(from)}`
        : `received ${this.summary(from)}`,
    );
  }

  /** The first message of type `t` at index `from` or later. */
  nextOf<T extends ServerMessage['t']>(
    t: T,
    opts: { from?: number; timeoutMs?: number; ch?: number } = {},
  ): Promise<Extract<ServerMessage, { t: T }>> {
    return this.next<Extract<ServerMessage, { t: T }>>(
      (m) => m.t === t && (opts.ch === undefined || ('ch' in m && m.ch === opts.ch)),
      `a ${t} message`,
      opts,
    );
  }

  /** The reply to the message whose envelope `id` is `id` (05 §4: a reply carries `re`). */
  reply(id: string, opts: { timeoutMs?: number } = {}): Promise<ServerMessage> {
    return this.next((m) => 're' in m && m.re === id, `the reply to ${id}`, opts);
  }

  /** Sends a message with a fresh `id` and waits for its reply. */
  async request(message: Record<string, unknown>, opts: { timeoutMs?: number } = {}) {
    const id = typeof message['id'] === 'string' ? message['id'] : this.nextId();
    this.send({ ...message, id });
    return { id, reply: await this.reply(id, opts) };
  }

  /** Whether a matching message arrives within `ms`; no failure either way. */
  async arrives(pred: (m: ServerMessage) => boolean, ms: number, from = 0): Promise<boolean> {
    return this.wait(() => this.messages.slice(from).some(pred), ms);
  }

  /** Waits for the connection to close; fails when it stays open. */
  async closes(what: string, timeoutMs?: number): Promise<Closed> {
    await this.wait(() => this.closed !== null, this.timeout(timeoutMs));
    if (this.closed) return this.closed;
    throw new KitFailure(
      `${this.label}: expected the server to close the connection (${what})`,
      what,
      `still open; received ${this.summary(0)}`,
    );
  }

  /** Waits `ms` and reports whether the connection is still open. */
  async staysOpen(ms: number): Promise<boolean> {
    await this.wait(() => this.closed !== null, ms);
    return this.closed === null;
  }

  /** Lets the server answer for a moment. */
  settle(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** The message types received from `from` on, for failure messages. */
  summary(from = 0): string {
    const types = this.messages.slice(from).map((m) => m.t);
    const tail = types.slice(-12).join(', ');
    return types.length
      ? `${types.length} messages (${types.length > 12 ? '…, ' : ''}${tail})`
      : 'nothing';
  }

  /** Closes the connection (normal closure) and waits briefly for the close to complete. */
  async close(code = 1000): Promise<void> {
    if (this.closed) return;
    this.ending = true;
    try {
      this.ws.close(code);
    } catch {
      this.ws.terminate();
    }
    await this.wait(() => this.closed !== null, 2000);
    if (!this.closed) this.ws.terminate();
  }

  /** Drops the TCP connection without a close frame (a client that vanished). */
  terminate(): void {
    this.ending = true;
    this.ws.terminate();
  }
}
