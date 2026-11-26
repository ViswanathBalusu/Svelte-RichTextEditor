/**
 * A local transparency log and the adapter that talks to it (SEC-066; ADR 0409 decision 5).
 *
 * `LocalTransparencyLog` is a small log in memory, served over HTTP on an address the caller
 * chooses (port 0 for an ephemeral one). It uses the hashing of RFC 6962 and signs its checkpoints
 * as C2SP signed notes with Ed25519, which is the format of the proposed public log. It is for
 * development, tests and a self-hosted operator who wants a log of their own. It is not the public
 * log, and it does not implement the tile read API or witness cosigning.
 *
 *   POST /entries        body: the entry; answers { index }. The same entry gives the same index.
 *   GET  /checkpoint     the signed checkpoint note of the tree now.
 *   GET  /inclusion?index=<n>&size=<m>   answers { proof: [hex, ...] }.
 *   GET  /lookup/<leaf hash hex>         answers { index }, or 404.
 *
 * `HttpTransparencyLog` is the `TransparencyLog` adapter for a log with that API. It checks the
 * checkpoint's signature with the log's public key and the inclusion proof before it returns a
 * receipt, so a receipt it returns has passed `checkReceipt`.
 */
import { createServer, type Server } from 'node:http';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import {
  LOG_RECEIPT_FORMAT,
  TransparencyLogUnavailableError,
  checkReceipt,
  type LogReceipt,
  type TransparencyLog,
} from './log-port.ts';
import {
  checkpointBody,
  fromHex,
  inclusionProof,
  leafHash,
  openNote,
  parseCheckpointBody,
  rawPublicKey,
  signNote,
  toHex,
  treeRoot,
  verifierKey,
  type LogVerifier,
} from './tlog.ts';

export class LocalTransparencyLog {
  readonly origin: string;
  readonly #key: KeyObject;
  readonly #entries: Buffer[] = [];
  readonly #leaves: Uint8Array[] = [];
  readonly #byLeaf = new Map<string, number>();
  #server: Server | null = null;

  constructor(origin = 'docedit-local-log', key?: KeyObject) {
    this.origin = origin;
    this.#key = key ?? generateKeyPairSync('ed25519').privateKey;
  }

  /** The log's public key as a relying party is given it. */
  get verifierKey(): string {
    return verifierKey(this.origin, rawPublicKey(this.#key));
  }

  /** The entries the log holds, for a test to look at what was sent. */
  get entries(): readonly Buffer[] {
    return this.#entries;
  }

  add(entry: Uint8Array): number {
    const leaf = leafHash(entry);
    const known = this.#byLeaf.get(toHex(leaf));
    if (known !== undefined) return known;
    this.#entries.push(Buffer.from(entry));
    this.#leaves.push(leaf);
    this.#byLeaf.set(toHex(leaf), this.#leaves.length - 1);
    return this.#leaves.length - 1;
  }

  checkpoint(): string {
    return signNote(
      checkpointBody({
        origin: this.origin,
        size: this.#leaves.length,
        root: toHex(treeRoot(this.#leaves)),
      }),
      this.origin,
      this.#key,
    );
  }

  proof(index: number, size: number): string[] | null {
    if (!Number.isInteger(size) || size < 1 || size > this.#leaves.length) return null;
    if (!Number.isInteger(index) || index < 0 || index >= size) return null;
    return inclusionProof(this.#leaves.slice(0, size), index).map(toHex);
  }

  /** Starts serving on `port` (0 for an ephemeral one) of the loopback address. Returns the URL. */
  async listen(port = 0): Promise<string> {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const send = (status: number, body: string, type = 'application/json'): void => {
        res.writeHead(status, { 'content-type': type });
        res.end(body);
      };
      if (req.method === 'POST' && url.pathname === '/entries') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => send(200, JSON.stringify({ index: this.add(Buffer.concat(chunks)) })));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/checkpoint')
        return send(200, this.checkpoint(), 'text/plain');
      if (req.method === 'GET' && url.pathname === '/inclusion') {
        const proof = this.proof(
          Number(url.searchParams.get('index')),
          Number(url.searchParams.get('size')),
        );
        return proof === null ? send(400, '{}') : send(200, JSON.stringify({ proof }));
      }
      const lookup = /^\/lookup\/([0-9a-f]{64})$/.exec(url.pathname);
      if (req.method === 'GET' && lookup !== null) {
        const index = this.#byLeaf.get(lookup[1]!);
        return index === undefined ? send(404, '{}') : send(200, JSON.stringify({ index }));
      }
      send(404, '{}');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    this.#server = server;
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    return `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    if (server === null) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export interface HttpTransparencyLogOptions {
  /** The log's base URL, without a trailing slash. */
  baseUrl: string;
  /** The log's public key, as `verifierKey` writes it. */
  verifierKey: LogVerifier;
  /** Milliseconds before a request is given up. */
  timeoutMs: number;
  fetch?: typeof fetch;
}

/** The adapter for a log with the API of `LocalTransparencyLog`. */
export class HttpTransparencyLog implements TransparencyLog {
  readonly id: string;
  readonly #o: HttpTransparencyLogOptions;

  constructor(options: HttpTransparencyLogOptions) {
    this.#o = options;
    this.id = options.verifierKey.name;
  }

  async #call(path: string, init?: RequestInit): Promise<Response> {
    const f = this.#o.fetch ?? fetch;
    try {
      return await f(`${this.#o.baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(this.#o.timeoutMs),
      });
    } catch (e) {
      throw new TransparencyLogUnavailableError('the log cannot be reached', { cause: e });
    }
  }

  async #receipt(entry: Uint8Array | null, index: number): Promise<LogReceipt> {
    const cp = await this.#call('/checkpoint');
    if (!cp.ok) throw new TransparencyLogUnavailableError(`the log answered ${cp.status}`);
    const note = await cp.text();
    const body = openNote(note, this.#o.verifierKey);
    const checkpoint = body === null ? null : parseCheckpointBody(body);
    if (checkpoint === null || checkpoint.origin !== this.id)
      throw new TransparencyLogUnavailableError('the checkpoint is not signed by the log key');
    const inc = await this.#call(`/inclusion?index=${index}&size=${checkpoint.size}`);
    if (!inc.ok) throw new TransparencyLogUnavailableError(`the log answered ${inc.status}`);
    const { proof } = (await inc.json()) as { proof: string[] };
    return {
      format: LOG_RECEIPT_FORMAT,
      logId: this.id,
      index,
      size: checkpoint.size,
      leafHash: entry === null ? '' : toHex(leafHash(entry)),
      proof,
      checkpoint: note,
    };
  }

  async submit(entry: Uint8Array): Promise<LogReceipt> {
    const res = await this.#call('/entries', { method: 'POST', body: entry });
    if (!res.ok) throw new TransparencyLogUnavailableError(`the log answered ${res.status}`);
    const { index } = (await res.json()) as { index: number };
    const receipt = await this.#receipt(entry, index);
    if (!checkReceipt(entry, receipt, this.#o.verifierKey).ok)
      throw new TransparencyLogUnavailableError('the log gave a receipt that does not verify');
    return receipt;
  }

  async getReceipt(leafHashHex: string): Promise<LogReceipt | null> {
    const res = await this.#call(`/lookup/${leafHashHex}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new TransparencyLogUnavailableError(`the log answered ${res.status}`);
    const { index } = (await res.json()) as { index: number };
    const receipt = await this.#receipt(null, index);
    return { ...receipt, leafHash: toHex(fromHex(leafHashHex)) };
  }
}
