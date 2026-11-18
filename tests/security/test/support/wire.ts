/**
 * The adversarial protocol client (SEC-002). It is not the component: it speaks the DEP wire
 * format itself, through the protocol package's codec (`@docedit/protocol`), so a test can send any
 * envelope, message type, channel number, chunk sequence and step JSON, including malformed ones,
 * with any token (10 §2; 10 §5). It can also withhold, delay and reorder frames and keep a
 * connection open without sending `hello`.
 *
 * It keeps every received message in order (chunks reassembled) and lets a test wait for one.
 */
import { depCodec, Reassembler, type ChunkPayload } from '@docedit/protocol';
import { WebSocket, type RawData } from 'ws';

const codec = depCodec();

export interface Received {
  t: string;
  id?: string;
  re?: string;
  ch?: number;
  d?: Record<string, unknown> & Record<string, unknown>;
}

export interface Closed {
  code: number;
  reason: string;
}

export interface ConnectOptions {
  /** The subprotocols offered; omit to offer `dep.v1` as a browser would. */
  protocols?: string[] | null;
  /** The `Origin` header; omit to send none (a non-browser client, ADR 0035). */
  origin?: string;
  perMessageDeflate?: boolean;
  /** The local source address, for per-address limits (U-SEC-017-032, SEC-018); omit for the default. */
  localAddress?: string;
  /** Extra headers of the upgrade request (a User-Agent, a forwarded address). */
  headers?: Record<string, string>;
}

export class WireClient {
  readonly ws: WebSocket;
  readonly log: Received[] = [];
  /** Raw text frames received, for checks on framing and chunking. */
  readonly frames: string[] = [];
  readonly closed: Promise<Closed>;
  closeInfo: Closed | null = null;
  #ids = 0;
  #waiters: Array<() => void> = [];
  readonly #taken = new Set<number>();
  readonly #reassembler = new Reassembler();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.closed = new Promise((resolve) => {
      ws.on('close', (code, reason) => {
        this.closeInfo = { code, reason: reason.toString('utf8') };
        resolve(this.closeInfo);
        this.#wake();
      });
    });
    ws.on('message', (data: RawData, isBinary: boolean) => {
      const text = isBinary ? '' : data.toString('utf8');
      this.frames.push(text);
      let m: Received;
      try {
        m = JSON.parse(text) as Received;
      } catch {
        return;
      }
      if (m.t === 'chunk') {
        const r = this.#reassembler.push(m.d as unknown as ChunkPayload, Date.now());
        if (r.status === 'complete') this.#receive(JSON.parse(r.text) as Received);
        return;
      }
      this.#receive(m);
    });
    ws.on('error', () => {});
  }

  #receive(m: Received): void {
    this.log.push(m);
    this.#wake();
  }

  #wake(): void {
    const w = this.#waiters;
    this.#waiters = [];
    for (const f of w) f();
  }

  static connect(url: string, opts: ConnectOptions = {}): Promise<WireClient> {
    const protocols = opts.protocols === null ? [] : (opts.protocols ?? ['dep.v1']);
    const ws = new WebSocket(url, protocols, {
      ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
      perMessageDeflate: opts.perMessageDeflate ?? false,
      ...(opts.localAddress !== undefined ? { localAddress: opts.localAddress } : {}),
      ...(opts.headers !== undefined ? { headers: opts.headers } : {}),
    });
    const c = new WireClient(ws);
    return new Promise((resolve, reject) => {
      ws.once('open', () => resolve(c));
      ws.once('unexpected-response', (_req, res) =>
        reject(
          Object.assign(new Error(`HTTP ${res.statusCode ?? '?'}`), { status: res.statusCode }),
        ),
      );
      ws.once('error', reject);
    });
  }

  nextId(): string {
    return `m${++this.#ids}`;
  }

  /** Sends an object as one JSON text frame (no validation: the test may craft an invalid one). */
  send(msg: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** Sends bytes exactly as given: a raw string, a binary frame, invalid UTF-8. */
  sendRaw(data: string | Buffer | Uint8Array, binary = false): void {
    this.ws.send(data, { binary });
  }

  /** Encodes through the codec with validation off, so a known type can carry a bad payload. */
  sendEncoded(msg: Record<string, unknown>): void {
    this.ws.send(codec.encode(msg, { validate: false }));
  }

  /** The first not-yet-taken message that matches, waiting for it up to `timeoutMs`. */
  async take(
    pred: (m: Received) => boolean,
    timeoutMs = 3000,
    what = 'a message',
  ): Promise<Received> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (let i = 0; i < this.log.length; i++) {
        if (this.#taken.has(i)) continue;
        const m = this.log[i]!;
        if (pred(m)) {
          this.#taken.add(i);
          return m;
        }
      }
      const left = deadline - Date.now();
      const noMore = this.closeInfo && !this.log.some((m, i) => !this.#taken.has(i) && pred(m));
      if (left <= 0 || noMore)
        throw new Error(
          `no ${what} within ${timeoutMs} ms${
            this.closeInfo ? ` (closed ${this.closeInfo.code} ${this.closeInfo.reason})` : ''
          }; got ${this.log.map((m) => m.t).join(', ')}`,
        );
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.#waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  all(t: string, ch?: number): Received[] {
    return this.log.filter((m) => m.t === t && (ch === undefined || m.ch === ch));
  }

  /** Sends `hello`; resolves with the answer (`welcome` or `error`). */
  async hello(token: string, extra: Record<string, unknown> = {}): Promise<Received> {
    const id = this.nextId();
    this.send({
      t: 'hello',
      id,
      d: {
        versions: ['1.0'],
        token,
        client: { name: 'adversary', version: '0' },
        engines: ['pm-steps/1'],
        cdm: { min: 1, max: 1 },
        features: ['presence', 'regions'],
        ...extra,
      },
    });
    return this.take((m) => m.re === id, 5000, `answer to hello ${id}`);
  }

  async open(
    ch: number,
    doc: string,
    opts: { resume?: Record<string, unknown>; token?: string; features?: string[] } = {},
  ): Promise<Received> {
    const id = this.nextId();
    this.send({
      t: 'ch.open',
      id,
      ch,
      d: {
        kind: 'doc',
        doc,
        engine: 'pm-steps/1',
        cdm: 1,
        features: opts.features ?? ['regions', 'presence'],
        ...(opts.resume ? { resume: opts.resume } : {}),
        ...(opts.token ? { token: opts.token } : {}),
      },
    });
    return this.take((m) => m.re === id, 5000, `answer to ch.open ${id}`);
  }

  /** Submits a commit and resolves with its `sync.ack` or `sync.reject`. */
  async submit(
    ch: number,
    commit: { id: string; base: number; steps: unknown[]; origin?: string },
    timeoutMs = 5000,
  ): Promise<Received> {
    const id = this.nextId();
    this.send({ t: 'sync.submit', id, ch, d: commit });
    return this.take((m) => m.re === id, timeoutMs, `answer to sync.submit ${id}`);
  }

  close(): void {
    try {
      this.ws.close(1000);
    } catch {
      /* already closing */
    }
  }

  terminate(): void {
    this.ws.terminate();
  }
}
