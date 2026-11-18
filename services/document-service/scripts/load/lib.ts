/**
 * The service latency, load and fault-injection harness (FND-009; 00 §9; 11 §4; 06 §6, §8).
 *
 * It runs the real service as a child process (`src/main.ts`, the process of BE-001), so that the
 * load generator and the service do not share an event loop, drives it over HTTP and the DEP
 * WebSocket, and measures what a client sees. It can kill the process and start it again on the
 * same database. Nothing here is part of the service; the scenarios are in `scenarios.ts` and the
 * command line is `scripts/load/fnd-009.ts`.
 *
 * Settings of a workload (counts, rates, durations) are settings of the run, named in its report.
 * They are not figures of the specification.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { uuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { Reassembler } from '@docedit/protocol';
import { WebSocket } from 'ws';
import { hashSecret } from '../../src/control-plane/tenants.ts';
import { newApiKey } from '../../src/control-plane/tokens.ts';

const SERVICE_DIR = fileURLToPath(new URL('../../', import.meta.url));

// --- Statistics ---------------------------------------------------------------------------------

export interface Summary {
  n: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

/** The value at rank ceil(p/100 * n) of a sorted sample (the nearest-rank percentile). */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1]!;
}

export function summarise(samples: readonly number[]): Summary {
  const s = [...samples].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length,
    min: s[0] ?? Number.NaN,
    p50: percentile(s, 50),
    p95: percentile(s, 95),
    p99: percentile(s, 99),
    max: s[s.length - 1] ?? Number.NaN,
    mean: s.length ? sum / s.length : Number.NaN,
  };
}

export const round = (n: number, digits = 1): number => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// --- A document the workloads write to ----------------------------------------------------------

/** The identifier of the first paragraph, where the writers insert text. */
export const INTRO = 'pIntro0000000001';

type JsonNode = Record<string, unknown>;

const paragraph = (id: string, text?: string): JsonNode => ({
  type: 'paragraph',
  attrs: { id, style: 'Normal' },
  ...(text ? { content: [{ type: 'text', text }] } : {}),
});

/**
 * A valid CDM document of `paragraphs` paragraphs after the first. The first is `INTRO`, with the
 * text "Hello", so that its content starts at the offset `introOffset()` gives.
 */
export function makeContent(paragraphs = 0, textLength = 60): JsonNode {
  const body: JsonNode[] = [paragraph(INTRO, 'Hello')];
  const filler = 'lorem ipsum dolor sit amet '
    .repeat(Math.ceil(textLength / 27))
    .slice(0, textLength);
  for (let i = 0; i < paragraphs; i++)
    body.push(paragraph(`p${String(i).padStart(15, '0')}`, filler));
  return {
    cdm: 1,
    requires: [],
    doc: {
      type: 'doc',
      content: [
        {
          type: 'defs',
          content: [
            {
              type: 'settings',
              attrs: { lang: 'en-GB', defaultTabStop: 720, defaultParagraphStyle: 'Normal' },
            },
            {
              type: 'style_def',
              attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal', builtIn: true },
            },
            {
              type: 'page_setup',
              attrs: {
                id: 'ps1',
                width: 11906,
                height: 16838,
                marginTop: 1440,
                marginRight: 1440,
                marginBottom: 1440,
                marginLeft: 1440,
              },
            },
          ],
        },
        { type: 'body', attrs: { pageSetup: 'ps1' }, content: body },
      ],
    },
  };
}

/** The position of the start of the first paragraph's content, from the schema. */
function introPos(): number {
  let at = -1;
  cdmSchema()
    .nodeFromJSON(makeContent().doc)
    .descendants((n, pos) => {
      if (n.attrs['id'] === INTRO) at = pos + 1;
      return at < 0;
    });
  if (at < 0) throw new Error('the first paragraph is missing');
  return at;
}

export const INTRO_POS = introPos();

/** A step that inserts text at the start of the first paragraph. */
export function insertAtIntro(text: string): Record<string, unknown> {
  return {
    stepType: 'replace',
    from: INTRO_POS,
    to: INTRO_POS,
    slice: { content: [{ type: 'text', text }] },
  };
}

// --- The service as a process -------------------------------------------------------------------

export interface ServiceOptions {
  /** A PostgreSQL URL for the service role; absent: memory storage, lost when the process ends. */
  databaseUrl?: string | null;
  /** Test mode: the fault hooks of BE-079, shortened timers. Off for latency measurements. */
  testMode?: boolean;
  /** Extra DOCEDIT_* settings. */
  env?: Record<string, string>;
  /** The tenant to use again after a restart; created when absent. */
  tenant?: { id: string; credential: string; seedFile: string; dir: string } | undefined;
}

export interface ServiceHandle {
  url: string;
  wsUrl: string;
  tenant: string;
  /** The API key credential of the tenant (a service credential). */
  credential: string;
  pid: number;
  /** Ends the process with SIGKILL (a crash) and waits for it to be gone. */
  kill(): Promise<void>;
  /** Ends the process with SIGTERM and waits; escalates to SIGKILL after 10 s. */
  stop(): Promise<void>;
  /** Everything the process wrote to its output, for the report on a failure. */
  output(): string;
  /** The tenant, so that a restart can use the same one. */
  readonly seed: NonNullable<ServiceOptions['tenant']>;
}

export async function startServiceProcess(opts: ServiceOptions = {}): Promise<ServiceHandle> {
  let seed = opts.tenant;
  if (!seed) {
    const dir = await mkdtemp(join(tmpdir(), 'docedit-load-'));
    const tenant = randomUUID();
    const key = newApiKey(tenant);
    const seedFile = join(dir, 'tenants.json');
    await writeFile(
      seedFile,
      JSON.stringify({
        tenants: [
          {
            id: tenant,
            name: 'load',
            apiKeys: [{ id: key.id, secretSha256: hashSecret(key.secret).toString('hex') }],
          },
        ],
      }),
    );
    seed = { id: tenant, credential: key.credential, seedFile, dir };
  }
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('DOCEDIT_')),
  );
  Object.assign(env, {
    DOCEDIT_LISTEN_HOST: '127.0.0.1',
    DOCEDIT_LISTEN_PORT: '0',
    DOCEDIT_TENANTS_FILE: seed.seedFile,
    DOCEDIT_ENVIRONMENT: 'test',
    ...(opts.testMode ? { DOCEDIT_TEST_MODE: '1' } : {}),
    ...(opts.databaseUrl ? { DOCEDIT_DATABASE_URL: opts.databaseUrl } : {}),
    ...(opts.env ?? {}),
  });
  const child: ChildProcess = spawn(process.execPath, ['src/main.ts'], {
    cwd: SERVICE_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`the service did not start within 30 s\n${out.slice(-2000)}`)),
      30_000,
    );
    const onData = (b: Buffer) => {
      out += b.toString('utf8');
      const m = /listening on (http:\/\/[^"\s]+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]!);
      }
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`the service exited with ${code} before it listened\n${out.slice(-2000)}`));
    });
  });
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('exit', () => resolve());
  });
  const discovery = (await (await fetch(`${url}/.well-known/dep`)).json()) as { ws: string };
  return {
    url,
    wsUrl: discovery.ws,
    tenant: seed.id,
    credential: seed.credential,
    pid: child.pid ?? -1,
    seed,
    output: () => out,
    async kill() {
      child.kill('SIGKILL');
      await exited;
    },
    async stop() {
      child.kill('SIGTERM');
      const t = setTimeout(() => child.kill('SIGKILL'), 10_000);
      await exited;
      clearTimeout(t);
    },
  };
}

/** Removes the temporary files of a service's tenant. */
export async function removeSeed(svc: ServiceHandle): Promise<void> {
  await rm(svc.seed.dir, { recursive: true, force: true });
}

// --- REST ---------------------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies of many shapes
export type Json = Record<string, any>;

export async function rest(
  svc: ServiceHandle,
  method: string,
  path: string,
  body?: unknown,
  prefix = '/v1',
): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${svc.url}${prefix}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${svc.credential}`,
      'Content-Type': 'application/json',
      // No reused sockets: a server may close an idle one just as the client sends on it.
      Connection: 'close',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Json) : {} };
}

export async function createDocument(svc: ServiceHandle, content: unknown): Promise<string> {
  const r = await rest(svc, 'POST', '/documents', { content });
  if (r.status !== 201 && r.status !== 200)
    throw new Error(`creating a document answered ${r.status}: ${JSON.stringify(r.json)}`);
  return r.json['id'] as string;
}

export async function mintToken(
  svc: ServiceHandle,
  sub: string,
  docs: Record<string, 'owner' | 'editor' | 'viewer'>,
): Promise<string> {
  const r = await rest(svc, 'POST', '/tokens', { sub, docs });
  if (r.status !== 200 && r.status !== 201)
    throw new Error(`minting a token answered ${r.status}: ${JSON.stringify(r.json)}`);
  return r.json['token'] as string;
}

// --- A light DEP client -------------------------------------------------------------------------

interface Message {
  t: string;
  id?: string;
  re?: string;
  ch?: number;
  d?: Json;
}

export interface Timed {
  ms: number;
  msg: Message | null;
}

/**
 * A DEP client for load: it keeps no log, only the answers still awaited and a count of the
 * commits it was sent. One request in flight per id; an answer that does not come within
 * `timeoutMs` is `msg: null`.
 */
export class LoadClient {
  readonly ws: WebSocket;
  closed = false;
  commitsSeen = 0;
  /** The codes of the `ch.closed` messages the service sent (for example `slow_consumer`). */
  readonly channelCloses: string[] = [];
  /** The WebSocket close code and reason, once the socket has closed. */
  socketClose: { code: number; reason: string } | null = null;
  #pending = new Map<string, (m: Message) => void>();
  #ids = 0;
  readonly #reassembler = new Reassembler();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString()) as Message;
      if (m.t === 'chunk') {
        const r = this.#reassembler.push(m.d as never, Date.now());
        if (r.status === 'complete') this.#receive(JSON.parse(r.text) as Message);
        return;
      }
      this.#receive(m);
    });
    ws.on('close', (code, reason) => {
      this.closed = true;
      this.#stopHeartbeat();
      this.socketClose = { code, reason: reason.toString('utf8') };
    });
    ws.on('error', () => {});
  }

  #receive(m: Message): void {
    // 05 §4: the service pings a connection it has not written to for a heartbeat interval, and
    // ends one it has not heard from for two. A client answers, as the kit's clients do.
    if (m.t === 'ping') this.#send({ t: 'pong', ...(m.id !== undefined ? { re: m.id } : {}) });
    if (m.t === 'sync.commit') this.commitsSeen++;
    if (m.t === 'ch.closed') this.channelCloses.push(String(m.d?.['code']));
    if (m.re) {
      const f = this.#pending.get(m.re);
      if (f) {
        this.#pending.delete(m.re);
        f(m);
      }
    }
  }

  /** Connects and says hello with `token`; throws when the service does not welcome it. */
  static async connect(wsUrl: string, token: string, timeoutMs = 10_000): Promise<LoadClient> {
    const ws = new WebSocket(wsUrl, ['dep.v1'], { perMessageDeflate: false });
    const c = new LoadClient(ws);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('connect timed out')), timeoutMs);
      ws.once('open', () => {
        clearTimeout(t);
        resolve();
      });
      ws.once('error', (e) => {
        clearTimeout(t);
        reject(e);
      });
      ws.once('unexpected-response', (_req, res) => {
        clearTimeout(t);
        reject(new Error(`HTTP ${res.statusCode}`));
      });
    });
    const r = await c.request('hello', undefined, {
      versions: ['1.0'],
      token,
      client: { name: 'load', version: '0' },
      engines: ['pm-steps/1'],
      cdm: { min: 1, max: 1 },
      features: ['presence', 'fields', 'regions'],
    });
    if (r.msg?.t !== 'welcome')
      throw new Error(`hello answered ${r.msg ? r.msg.t : 'nothing'}: ${JSON.stringify(r.msg?.d)}`);
    const limits = r.msg.d?.['limits'] as { heartbeatMs?: number } | undefined;
    c.#startHeartbeat(limits?.heartbeatMs ?? 25_000);
    return c;
  }

  #lastSent = Date.now();
  #heartbeat: ReturnType<typeof setInterval> | null = null;

  #send(m: Record<string, unknown>): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.#lastSent = Date.now();
    this.ws.send(JSON.stringify(m));
  }

  /**
   * 05 §4: either side sends `ping` when it has sent nothing for `heartbeatMs`, and a side that
   * hears nothing for two intervals closes the connection. A watcher that never writes would
   * otherwise be ended by the service after two intervals, whatever the service sends it.
   */
  #startHeartbeat(heartbeatMs: number): void {
    this.#heartbeat = setInterval(
      () => {
        if (this.closed) return this.#stopHeartbeat();
        if (Date.now() - this.#lastSent >= heartbeatMs) this.#send({ t: 'ping' });
      },
      Math.max(100, Math.floor(heartbeatMs / 2)),
    );
    this.#heartbeat.unref?.();
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
  }

  async request(t: string, ch: number | undefined, d: unknown, timeoutMs = 10_000): Promise<Timed> {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return { ms: 0, msg: null };
    const id = `m${++this.#ids}`;
    const start = performance.now();
    return new Promise<Timed>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        resolve({ ms: performance.now() - start, msg: null });
      }, timeoutMs);
      this.#pending.set(id, (m) => {
        clearTimeout(timer);
        resolve({ ms: performance.now() - start, msg: m });
      });
      this.#send({ t, id, ...(ch !== undefined ? { ch } : {}), d });
    });
  }

  open(ch: number, doc: string, resume?: Record<string, unknown>): Promise<Timed> {
    return this.request('ch.open', ch, {
      kind: 'doc',
      doc,
      engine: 'pm-steps/1',
      cdm: 1,
      features: ['fields', 'presence', 'regions'],
      ...(resume ? { resume } : {}),
    });
  }

  /** Inserts `text` at the start of the first paragraph on top of head `base`. */
  submit(ch: number, base: number, text: string, timeoutMs = 10_000): Promise<Timed> {
    return this.request(
      'sync.submit',
      ch,
      { id: uuid7(), base, steps: [insertAtIntro(text)], origin: 'input' },
      timeoutMs,
    );
  }

  terminate(): void {
    this.ws.terminate();
  }

  close(): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close(1000);
  }
}

/** Runs `fn` over `items` with at most `limit` in flight at once. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
