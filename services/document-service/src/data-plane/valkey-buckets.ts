/**
 * Token buckets shared between nodes through Redis or Valkey (BE-063). The buckets are the
 * gateway's `RateLimits` counters in another form: a bucket is one hash in Valkey, refilled and
 * taken by one Lua script, so two nodes that share a key share its tokens.
 *
 * Only counters live here. A lost key (a flush, an eviction) gives a bucket its full capacity
 * again, which loosens a limit for a moment; it never touches a commit, a grant, a lease or an
 * owner (BE-063 criterion 3). When Valkey cannot be reached the store answers from a local bucket
 * of the same settings, so the node keeps limiting its own clients and never fails a request
 * because the shared store is down (BE-063 criterion 4). The clock is the caller's; nodes whose
 * clocks differ by more than a refill interval see slightly different buckets.
 *
 * The client speaks RESP2 over `node:net` directly, so the service needs no new dependency. It
 * sends one command at a time per connection; a timeout closes the connection and the next
 * command reconnects.
 */
import net from 'node:net';
import type { BucketSettings } from '../seams.ts';
import { TokenBucket } from './limits.ts';

/** The Lua script: refill, then take `n` tokens or report the wait (milliseconds). */
export const TAKE_SCRIPT = `
local cap = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local n = tonumber(ARGV[4])
local d = redis.call('HMGET', KEYS[1], 'tokens', 'at')
local tokens = tonumber(d[1])
local at = tonumber(d[2])
if tokens == nil then
  tokens = cap
  at = now
end
if now > at then
  tokens = math.min(cap, tokens + ((now - at) / 1000) * rate)
  at = now
end
local wait = 0
if tokens >= n then
  tokens = tokens - n
elseif rate == 0 then
  wait = 9007199254740991
else
  wait = math.ceil(((n - tokens) / rate) * 1000)
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'at', tostring(at))
if rate > 0 then
  redis.call('PEXPIRE', KEYS[1], math.ceil(((cap - tokens) / rate) * 1000) + 1000)
end
return wait
`;

export interface ValkeyUrl {
  readonly host: string;
  readonly port: number;
}

/** Parses `redis://host:port` (or `valkey://`); the port defaults to 6379. */
export function parseValkeyUrl(url: string): ValkeyUrl {
  const u = new URL(url);
  if (u.protocol !== 'redis:' && u.protocol !== 'valkey:') {
    throw new Error(`unsupported store URL scheme "${u.protocol}"`);
  }
  return { host: u.hostname, port: u.port === '' ? 6379 : Number(u.port) };
}

/** A RESP2 reply: a simple string, an integer, a bulk string (or null) or an array. */
export type RespValue = string | number | null | RespValue[];

/** Encodes one command as an array of bulk strings. */
export function encodeCommand(args: readonly string[]): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`, 'utf8')];
  for (const a of args) {
    const b = Buffer.from(a, 'utf8');
    parts.push(Buffer.from(`$${b.length}\r\n`, 'utf8'), b, Buffer.from('\r\n', 'utf8'));
  }
  return Buffer.concat(parts);
}

/** A reply error from the server, such as a script error. */
export class ValkeyReplyError extends Error {}

/**
 * Parses one reply that starts at `at`. Returns the value and the offset after it, or undefined
 * when the buffer does not yet hold the whole reply.
 */
export function parseReply(
  buf: Buffer,
  at: number,
): { value: RespValue; next: number } | undefined {
  if (at >= buf.length) return undefined;
  const type = String.fromCharCode(buf[at]!);
  const eol = buf.indexOf('\r\n', at, 'utf8');
  if (eol < 0) return undefined;
  const line = buf.toString('utf8', at + 1, eol);
  const after = eol + 2;
  switch (type) {
    case '+':
      return { value: line, next: after };
    case '-':
      throw new ValkeyReplyError(line);
    case ':':
      return { value: Number(line), next: after };
    case '$': {
      const len = Number(line);
      if (len < 0) return { value: null, next: after };
      if (buf.length < after + len + 2) return undefined;
      return { value: buf.toString('utf8', after, after + len), next: after + len + 2 };
    }
    case '*': {
      const count = Number(line);
      if (count < 0) return { value: null, next: after };
      const items: RespValue[] = [];
      let pos = after;
      for (let i = 0; i < count; i++) {
        const item = parseReply(buf, pos);
        if (item === undefined) return undefined;
        items.push(item.value);
        pos = item.next;
      }
      return { value: items, next: pos };
    }
    default:
      throw new ValkeyReplyError(`unexpected reply type "${type}"`);
  }
}

interface Pending {
  resolve(v: RespValue): void;
  reject(e: Error): void;
}

/** One connection to a Valkey server, with commands answered in order. */
export class ValkeyClient {
  readonly #url: ValkeyUrl;
  readonly #timeoutMs: number;
  #socket: net.Socket | null = null;
  #connecting: Promise<net.Socket> | null = null;
  #buf: Buffer = Buffer.alloc(0);
  #pending: Pending[] = [];

  constructor(url: ValkeyUrl, timeoutMs: number) {
    this.#url = url;
    this.#timeoutMs = timeoutMs;
  }

  #connect(): Promise<net.Socket> {
    if (this.#socket !== null) return Promise.resolve(this.#socket);
    if (this.#connecting !== null) return this.#connecting;
    this.#connecting = new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection({ host: this.#url.host, port: this.#url.port });
      const timer = setTimeout(() => {
        s.destroy(new Error('connect timeout'));
      }, this.#timeoutMs);
      s.once('connect', () => {
        clearTimeout(timer);
        this.#socket = s;
        this.#buf = Buffer.alloc(0);
        s.on('data', (chunk: Buffer) => this.#onData(chunk));
        s.on('error', (e) => this.#fail(e));
        s.on('close', () => this.#fail(new Error('connection closed')));
        resolve(s);
      });
      s.once('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    const reset = (): void => {
      this.#connecting = null;
    };
    this.#connecting.then(reset, reset);
    return this.#connecting;
  }

  #onData(chunk: Buffer): void {
    this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk]);
    for (;;) {
      const head = this.#pending[0];
      if (head === undefined) return;
      let reply: { value: RespValue; next: number } | undefined;
      try {
        reply = parseReply(this.#buf, 0);
      } catch (e) {
        this.#pending.shift();
        head.reject(e instanceof Error ? e : new Error(String(e)));
        continue;
      }
      if (reply === undefined) return;
      this.#buf = this.#buf.subarray(reply.next);
      this.#pending.shift();
      head.resolve(reply.value);
    }
  }

  /** Drops the connection and fails every command waiting on it. */
  #fail(e: Error): void {
    const s = this.#socket;
    this.#socket = null;
    this.#buf = Buffer.alloc(0);
    if (s !== null) s.destroy();
    const waiting = this.#pending;
    this.#pending = [];
    for (const p of waiting) p.reject(e);
  }

  async command(...args: string[]): Promise<RespValue> {
    const s = await this.#connect();
    return new Promise<RespValue>((resolve, reject) => {
      const timer = setTimeout(() => this.#fail(new Error('command timeout')), this.#timeoutMs);
      this.#pending.push({
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      s.write(encodeCommand(args));
    });
  }

  close(): void {
    this.#fail(new Error('client closed'));
  }
}

export interface SharedBucketOptions {
  /** `redis://host:port` of the Valkey server. */
  readonly url: string;
  /** Prefix of every key; a deployment or a test run names its own. */
  readonly prefix?: string;
  /** Connect and command timeout in milliseconds. */
  readonly timeoutMs?: number;
}

export interface SharedBucketStats {
  /** Takes answered by Valkey. */
  shared: number;
  /** Takes answered from the local fallback because Valkey failed. */
  degraded: number;
}

/**
 * The shared take. Each call is one Lua script on the server, so two nodes taking from one key
 * never both take the last token.
 */
export class ValkeyTokenBuckets {
  readonly #client: ValkeyClient;
  readonly #prefix: string;
  readonly #local = new Map<string, TokenBucket>();
  readonly stats: SharedBucketStats = { shared: 0, degraded: 0 };

  constructor(opts: SharedBucketOptions) {
    this.#client = new ValkeyClient(parseValkeyUrl(opts.url), opts.timeoutMs ?? 1000);
    this.#prefix = opts.prefix ?? 'docedit:rl:';
  }

  /**
   * Takes `n` tokens from the bucket named `key` with the given settings. Resolves to 0 when they
   * were there, otherwise to the milliseconds until they would be, as `TokenBucket.take` does.
   */
  async take(key: string, s: BucketSettings, nowMs: number, n = 1): Promise<number> {
    const cap = Math.max(1, s.capacity);
    const rate = Math.max(0, s.refillPerSecond);
    try {
      const reply = await this.#client.command(
        'EVAL',
        TAKE_SCRIPT,
        '1',
        `${this.#prefix}${key}`,
        String(cap),
        String(rate),
        String(nowMs),
        String(n),
      );
      if (typeof reply !== 'number') throw new ValkeyReplyError('take did not return an integer');
      this.stats.shared++;
      return reply;
    } catch {
      this.stats.degraded++;
      let b = this.#local.get(key);
      if (b === undefined) {
        b = new TokenBucket({ capacity: cap, refillPerSecond: rate }, nowMs);
        this.#local.set(key, b);
      }
      return b.take(nowMs, n);
    }
  }

  /** Runs one raw command; used by tests and by operators (`DEL` of a key, for example). */
  async raw(...args: string[]): Promise<RespValue> {
    return this.#client.command(...args);
  }

  close(): void {
    this.#client.close();
  }
}
