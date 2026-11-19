/**
 * The kit's webhook receiver (05 §7, §11; PRO-121). The bootstrap contract of 05 §11 has the kit
 * register a webhook that points at itself: this is the HTTP server behind that address. It records
 * every request with the time it arrived, answers with the status a scenario chooses, and never
 * judges a request itself: the scenarios do.
 *
 * Where it listens and the URL the target reaches it at are the operator's to give (`receiver` in
 * the kit configuration), because the target's egress policy refuses private and loopback
 * addresses (10 §3.2): a run against a hosted server needs a public name, and a run against a test
 * server may name the receiver's address in the server's own test-mode allow-list.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One request the receiver took. */
export interface Received {
  /** The request path, which tells the webhooks of one scenario apart. */
  readonly path: string;
  /** Header names in lower case. */
  readonly headers: Readonly<Record<string, string>>;
  /** The body, exactly as it arrived. */
  readonly body: string;
  /** Milliseconds since the epoch, on the kit's clock. */
  readonly at: number;
  /** The status the receiver answered with. */
  readonly status: number;
}

export interface ReceiverOptions {
  /** The address to listen on (default `127.0.0.1`). */
  host?: string;
  /** The port (default 0: the system picks one). */
  port?: number;
  /** The URL the target reaches the receiver at, without a path (default `http://<host>:<port>`). */
  url?: string;
}

export class Receiver {
  readonly #server: Server;
  readonly #base: string;
  readonly #log: Received[] = [];
  #answer: (r: Omit<Received, 'status'>, n: number) => number = () => 204;
  readonly #seen = new Map<string, number>();

  private constructor(server: Server, base: string) {
    this.#server = server;
    this.#base = base;
  }

  static async start(opts: ReceiverOptions = {}): Promise<Receiver> {
    const host = opts.host ?? '127.0.0.1';
    const holder: { receiver?: Receiver } = {};
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
        holder.receiver!.#take(
          {
            path: req.url ?? '/',
            headers,
            body: Buffer.concat(chunks).toString('utf8'),
            at: Date.now(),
          },
          (status) => {
            res.statusCode = status;
            res.end();
          },
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(opts.port ?? 0, host, () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    const base = (opts.url ?? `http://${host}:${port}`).replace(/\/$/, '');
    const receiver = new Receiver(server, base);
    holder.receiver = receiver;
    return receiver;
  }

  /** The URL of one webhook of the kit: the base and a path of the scenario's choosing. */
  urlFor(path: string): string {
    return `${this.#base}/${path.replace(/^\//, '')}`;
  }

  /** What the receiver took so far, in order. */
  get received(): readonly Received[] {
    return this.#log;
  }

  /**
   * Chooses the status of the answers. `n` counts the earlier requests that carried the same
   * `webhook-id` (0 for the first attempt), so a scenario can fail the first attempts of a delivery.
   */
  answerWith(fn: (r: Omit<Received, 'status'>, n: number) => number): void {
    this.#answer = fn;
  }

  /** Resolves with the first request from `from` on that `pred` accepts, or rejects after `ms`. */
  async waitFor(
    pred: (r: Received) => boolean,
    ms: number,
    from = 0,
  ): Promise<Received | undefined> {
    const end = Date.now() + ms;
    for (;;) {
      const hit = this.#log.slice(from).find(pred);
      if (hit) return hit;
      if (Date.now() >= end) return undefined;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  #take(r: Omit<Received, 'status'>, send: (status: number) => void): void {
    const id = r.headers['webhook-id'] ?? '';
    const n = this.#seen.get(id) ?? 0;
    this.#seen.set(id, n + 1);
    const status = this.#answer(r, n);
    this.#log.push({ ...r, status });
    send(status);
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.#server.closeAllConnections();
      this.#server.close(() => resolve());
    });
  }
}
