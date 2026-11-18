/**
 * A DEP client for tests: a real WebSocket (`ws`), every message it receives kept in order, and
 * helpers that send a message and wait for its answer. It reassembles chunks as 05 §4 says.
 */
import { uuid7 } from '@docedit/model';
import { Reassembler } from '@docedit/protocol';
import { WebSocket } from 'ws';

export interface Received {
  t: string;
  id?: string;
  re?: string;
  ch?: number;
  d?: Record<string, unknown> & Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface Closed {
  code: number;
  reason: string;
}

export class DepClient {
  readonly ws: WebSocket;
  /** Every message received, in order (chunks reassembled). */
  readonly log: Received[] = [];
  /** Raw frames received, for checks on framing. */
  readonly frames: string[] = [];
  readonly closed: Promise<Closed>;
  closeInfo: Closed | null = null;
  /** The token the client said hello with, when the test harness made it. */
  token: string | undefined;
  #taken = new Set<number>();
  #waiters: Array<() => void> = [];
  #ids = 0;
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
    ws.on('message', (data, binary) => {
      const text = binary ? '' : data.toString();
      this.frames.push(text);
      const m = JSON.parse(text) as Received;
      if (m.t === 'chunk') {
        const r = this.#reassembler.push(m.d as never, Date.now());
        if (r.status === 'complete') this.#receive(JSON.parse(r.text) as Received);
        return;
      }
      this.#receive(m);
    });
    ws.on('error', () => {});
  }

  /** Called with every message as it arrives, after it is logged. */
  onMessage: ((m: Received) => void) | undefined;

  #receive(m: Received): void {
    this.log.push(m);
    this.onMessage?.(m);
    this.#wake();
  }

  #wake(): void {
    const w = this.#waiters;
    this.#waiters = [];
    for (const f of w) f();
  }

  static connect(
    url: string,
    opts: {
      protocols?: string[];
      origin?: string;
      perMessageDeflate?: boolean;
      /** Extra headers of the upgrade request (a User-Agent, a forwarded address). */
      headers?: Record<string, string>;
    } = {},
  ): Promise<DepClient> {
    const ws = new WebSocket(url, opts.protocols ?? ['dep.v1'], {
      ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
      ...(opts.headers !== undefined ? { headers: opts.headers } : {}),
      perMessageDeflate: opts.perMessageDeflate ?? false,
    });
    const c = new DepClient(ws);
    return new Promise((resolve, reject) => {
      ws.once('open', () => resolve(c));
      ws.once('unexpected-response', (_req, res) =>
        reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })),
      );
      ws.once('error', reject);
    });
  }

  nextId(): string {
    return `m${++this.#ids}`;
  }

  send(msg: object): void {
    this.ws.send(JSON.stringify(msg));
  }

  sendRaw(data: string | Buffer, binary = false): void {
    this.ws.send(data, { binary });
  }

  /** The first message not yet taken that matches, waiting for it if needed. */
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
      if (left <= 0 || (this.closeInfo && !this.log.some((m, i) => !this.#taken.has(i) && pred(m))))
        throw new Error(
          `no ${what} within ${timeoutMs} ms${this.closeInfo ? ` (closed ${this.closeInfo.code} ${this.closeInfo.reason})` : ''}; got ${this.log.map((m) => m.t).join(', ')}`,
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

  /** Messages of a type, in order of arrival. */
  all(t: string, ch?: number): Received[] {
    return this.log.filter((m) => m.t === t && (ch === undefined || m.ch === ch));
  }

  async hello(token: string, extra: Record<string, unknown> = {}): Promise<Received> {
    const id = this.nextId();
    this.send({
      t: 'hello',
      id,
      d: {
        versions: ['1.0'],
        token,
        client: { name: 'test', version: '0' },
        engines: ['pm-steps/1'],
        cdm: { min: 1, max: 1 },
        features: ['presence', 'fields', 'regions'],
        ...extra,
      },
    });
    return this.take((m) => m.re === id, 3000, `answer to hello ${id}`);
  }

  async open(
    ch: number,
    doc: string,
    opts: {
      resume?: Record<string, unknown>;
      features?: string[];
      token?: string;
      cdm?: number;
      engine?: string;
    } = {},
  ): Promise<Received> {
    const id = this.nextId();
    this.send({
      t: 'ch.open',
      id,
      ch,
      d: {
        kind: 'doc',
        doc,
        engine: opts.engine ?? 'pm-steps/1',
        cdm: opts.cdm ?? 1,
        features: opts.features ?? ['fields', 'presence', 'regions'],
        ...(opts.resume ? { resume: opts.resume } : {}),
        ...(opts.token ? { token: opts.token } : {}),
      },
    });
    return this.take((m) => m.re === id, 5000, `answer to ch.open ${id}`);
  }

  /** Sends a commit; resolves with its `sync.ack` or `sync.reject`. */
  async submit(
    ch: number,
    commit: { id?: string; base: number; steps: unknown[]; origin?: string },
    timeoutMs = 5000,
  ): Promise<Received> {
    const id = this.nextId();
    this.send({ t: 'sync.submit', id, ch, d: { id: commit.id ?? uuid7(), ...commit } });
    return this.take((m) => m.re === id, timeoutMs, `answer to sync.submit ${id}`);
  }

  /** Sends a commit without waiting; returns the envelope id. */
  submitNoWait(
    ch: number,
    commit: { id?: string; base: number; steps: unknown[]; origin?: string },
  ): string {
    const id = this.nextId();
    this.send({ t: 'sync.submit', id, ch, d: { id: commit.id ?? uuid7(), ...commit } });
    return id;
  }

  close(): void {
    this.ws.close(1000);
  }

  terminate(): void {
    this.ws.terminate();
  }
}

/** A step that inserts `text` at `pos` (prosemirror-transform's ReplaceStep JSON). */
export function insertText(pos: number, text: string): Record<string, unknown> {
  return { stepType: 'replace', from: pos, to: pos, slice: { content: [{ type: 'text', text }] } };
}
