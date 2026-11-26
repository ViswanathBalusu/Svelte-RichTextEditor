/**
 * The data plane in process for tests (PLAN-1a packet A1): an HTTP server whose upgrades go to
 * `createDataPlane`, over `MemoryStore` or the PostgreSQL stores, with a token registry in place of
 * the control plane's verifier and checkpoints in memory for the content at sequence number 0.
 */
import { createServer, type Server } from 'node:http';
import type {
  DocRole,
  PermissionState,
  LogCommit,
  WriteRequest,
  WriteResult,
} from '@docedit/authority';
import { uuid7, type JsonEnvelope } from '@docedit/model';
import {
  BASE_JSON,
  REQUIRES,
  USERS,
  basePermissions,
  type UserName,
} from '../../../../packages/authority/test/fixtures.ts';
import { createDepDataPlane, type DepDataPlaneInstance } from '../../src/data-plane/index.ts';
import type {
  DataPlaneDeps,
  DataPlaneSettings,
  UserLookup,
  VerifiedIdentity,
} from '../../src/seams.ts';
import { MemoryStore } from '../../src/storage/memory.ts';
import type {
  CheckpointStore,
  DocRef,
  DocumentStore,
  GrantStore,
  LogStore,
  OwnershipStore,
} from '../../src/storage/types.ts';
import { listenOnFetchablePort } from '../support/ports.ts';
import { DepClient } from './client.ts';

export { BASE_JSON, REQUIRES, USERS, basePermissions, type UserName };

/** Checkpoints in memory: the content at sequence number 0 of each document (D67). */
export class MemoryCheckpoints implements CheckpointStore {
  readonly #map = new Map<string, JsonEnvelope>();
  async put(ref: DocRef, seq: number, content: JsonEnvelope): Promise<void> {
    this.#map.set(`${ref.tenant}/${ref.doc}/${seq}`, structuredClone(content));
  }
  async get(ref: DocRef, seq: number): Promise<JsonEnvelope | null> {
    const c = this.#map.get(`${ref.tenant}/${ref.doc}/${seq}`);
    return c ? structuredClone(c) : null;
  }
  async latest(ref: DocRef, atOrBefore: number) {
    for (let s = atOrBefore; s >= 0; s--) {
      const c = await this.get(ref, s);
      if (c) return { seq: s, content: c };
    }
    return null;
  }
  /** The side objects (comment ranges; SYN-032), as bytes. */
  readonly sides = new Map<string, Uint8Array>();
  async putSide(ref: DocRef, seq: number, bytes: Uint8Array): Promise<void> {
    this.sides.set(`${ref.tenant}/${ref.doc}/${seq}`, bytes.slice());
  }
  async getSide(ref: DocRef, seq: number): Promise<Uint8Array | null> {
    return this.sides.get(`${ref.tenant}/${ref.doc}/${seq}`)?.slice() ?? null;
  }
}

export interface Stores {
  logs: LogStore;
  ownership: OwnershipStore;
  grants: GrantStore;
  documents: DocumentStore;
}

export function memoryStores(): Stores & { memory: MemoryStore } {
  const memory = new MemoryStore();
  return { memory, logs: memory, ownership: memory, grants: memory, documents: memory };
}

interface TokenSpec {
  user: UserName;
  docs: Record<string, DocRole>;
  /** Milliseconds until the token expires (default 15 minutes). */
  expiresIn?: number;
  tenant?: string;
  name?: string;
  groups?: readonly string[];
  /** Output restrictions of the `restrict` claim (PRO-015). */
  restrict?: readonly string[];
  /** The `access_since` claim as Unix milliseconds (08 §9; the `since_access` gate). */
  accessSince?: number;
}

/** Tokens as opaque strings mapped to identities, in place of signed JWTs (BE-012 is A2's). */
export class Tokens {
  readonly #issued = new Map<string, VerifiedIdentity>();
  readonly #now: () => number;
  readonly tenant: string;
  /** Tokens refused with a given code. */
  readonly refusals = new Map<string, string>();

  constructor(tenant: string, now: () => number) {
    this.tenant = tenant;
    this.#now = now;
  }

  issue(spec: TokenSpec): string {
    const token = `tok_${uuid7()}`;
    const base = USERS[spec.user];
    const first = Object.keys(spec.docs)[0] ?? uuid7();
    const issuedAt = this.#now();
    const identity: VerifiedIdentity = {
      tenant: spec.tenant ?? this.tenant,
      doc: first,
      connection: {
        ...base,
        role: spec.docs[first] ?? base.role,
        ...(spec.groups ? { groups: spec.groups } : {}),
        ...(spec.accessSince !== undefined ? { accessSince: spec.accessSince } : {}),
        ...(spec.agent !== undefined ? { agent: spec.agent } : {}),
      },
      jti: uuid7(),
      expiresAt: issuedAt + (spec.expiresIn ?? 15 * 60_000),
      docs: { ...spec.docs },
      sub: `host-${spec.user}`,
      ...(spec.name !== undefined ? { name: spec.name } : {}),
      issuedAt,
      restrict: [...(spec.restrict ?? [])],
    };
    this.#issued.set(token, identity);
    return token;
  }

  identity(token: string): VerifiedIdentity {
    const id = this.#issued.get(token);
    if (!id) throw new Error('unknown test token');
    return id;
  }

  /** The control plane's user mapping (BE-013): surrogate `alice` is host `sub` `host-alice`. */
  readonly users: UserLookup = {
    subsOf: async (_tenant, surrogates) =>
      new Map(surrogates.filter((s) => s in USERS).map((s) => [s, `host-${s}`])),
    surrogateOf: async (_tenant, sub) => sub.replace(/^host-/, ''),
  };

  verify = async (token: string): Promise<VerifiedIdentity> => {
    const refused = this.refusals.get(token);
    if (refused) throw Object.assign(new Error('refused'), { code: refused });
    const id = this.#issued.get(token);
    if (!id) throw Object.assign(new Error('unknown token'), { code: 'unauthenticated' });
    if (id.expiresAt <= this.#now())
      throw Object.assign(new Error('expired'), { code: 'token_expired' });
    return id;
  };
}

export interface Plane {
  plane: DepDataPlaneInstance;
  url: string;
  server: Server;
  stores: Stores;
  checkpoints: MemoryCheckpoints;
  tokens: Tokens;
  tenant: string;
  errors: unknown[];
  /** A document with the fixture content (three regions, a field) and the fixture grants. */
  createDocument(opts?: { perms?: PermissionState; requires?: string[] }): Promise<string>;
  ref(doc: string): DocRef;
  /** A connected client after `hello` and `welcome`. */
  client(
    user: UserName,
    docs: Record<string, DocRole>,
    opts?: Partial<TokenSpec>,
  ): Promise<DepClient>;
  /** Changes permission data the way the control plane does, and tells the room (or not). */
  changeGrants(
    doc: string,
    change: Parameters<GrantStore['change']>[1],
    notify?: boolean,
  ): Promise<PermissionState>;
  close(): Promise<void>;
}

export async function startPlane(
  opts: {
    stores?: Stores;
    settings?: DataPlaneSettings;
    tenant?: string;
    now?: () => number;
    deps?: Partial<DataPlaneDeps>;
    node?: string;
    checkpoints?: MemoryCheckpoints;
  } = {},
): Promise<Plane> {
  const stores = opts.stores ?? memoryStores();
  const tenant = opts.tenant ?? crypto.randomUUID();
  const now = opts.now ?? (() => Date.now());
  const tokens = new Tokens(tenant, now);
  const checkpoints = opts.checkpoints ?? new MemoryCheckpoints();
  const errors: unknown[] = [];
  const plane = createDepDataPlane({
    logs: stores.logs,
    ownership: stores.ownership,
    grants: stores.grants,
    documents: stores.documents,
    checkpoints,
    verify: tokens.verify,
    users: tokens.users,
    node: opts.node ?? `node-${uuid7()}`,
    now,
    settings: {
      onError: (e) => errors.push(e),
      // Heavy work runs inline unless a test asks for worker threads (SYN-039 tests do).
      workers: 0,
      drainTimeoutMs: 2000,
      ...opts.settings,
    },
    ...opts.deps,
  });
  const server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  server.on('upgrade', (req, socket, head) => plane.handleUpgrade(req, socket, head));
  // Never a port that fetch and WebSocket refuse (`bad port`; test/support/ports.ts).
  const port = await listenOnFetchablePort(server);
  const url = `ws://127.0.0.1:${port}/dep`;
  const clients: DepClient[] = [];
  const p: Plane = {
    plane,
    url,
    server,
    stores,
    checkpoints,
    tokens,
    tenant,
    errors,
    async createDocument(o = {}) {
      const id = uuid7();
      const perms = o.perms ?? basePermissions();
      await stores.documents.create(tenant, {
        id,
        cdmVersion: 1,
        requires: o.requires ?? REQUIRES,
        createdBy: 'alice',
        permissions: perms,
      });
      await checkpoints.put({ tenant, doc: id }, 0, {
        cdm: 1,
        requires: o.requires ?? REQUIRES,
        doc: BASE_JSON as JsonEnvelope['doc'],
      });
      return id;
    },
    ref: (doc) => ({ tenant, doc }),
    async client(user, docs, o = {}) {
      const token = tokens.issue({ user, docs, ...o });
      const c = await DepClient.connect(url);
      clients.push(c);
      c.token = token;
      await c.hello(token);
      return c;
    },
    async changeGrants(doc, change, notify = true) {
      const perms = await stores.grants.change({ tenant, doc }, change, { actor: 'alice' });
      if (notify) plane.permissionsChanged({ tenant, doc }, perms);
      return perms;
    },
    async close() {
      for (const c of clients) c.terminate();
      await plane.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  return p;
}

/**
 * A log store whose writes can be held and released one by one, or answered with a chosen outcome
 * (BE-024, BE-025). It also counts how many writes were in flight at once.
 */
export class GatedLogStore implements LogStore {
  readonly inner: LogStore;
  hold = false;
  inFlight = 0;
  maxInFlight = 0;
  readonly requests: WriteRequest[] = [];
  readonly #pending: Array<{
    ref: DocRef;
    req: WriteRequest;
    resolve: (r: WriteResult) => void;
    reject: (e: unknown) => void;
  }> = [];

  constructor(inner: LogStore) {
    this.inner = inner;
  }

  get pending(): number {
    return this.#pending.length;
  }

  append(ref: DocRef, req: WriteRequest): Promise<WriteResult> {
    this.requests.push(req);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    const done = (p: Promise<WriteResult>) =>
      p.finally(() => {
        this.inFlight--;
      });
    if (!this.hold) return done(this.inner.append(ref, req));
    return done(
      new Promise<WriteResult>((resolve, reject) =>
        this.#pending.push({ ref, req, resolve, reject }),
      ),
    );
  }

  /**
   * Settles the oldest held write: performs it, or answers with `outcome` without storing (a
   * function gets the request), or rejects with an error.
   */
  async release(
    outcome?: WriteResult | Error | ((req: WriteRequest) => Promise<WriteResult>),
  ): Promise<WriteRequest> {
    const w = this.#pending.shift();
    if (!w) throw new Error('no held write');
    if (outcome instanceof Error) w.reject(outcome);
    else if (typeof outcome === 'function') w.resolve(await outcome(w.req));
    else if (outcome) w.resolve(outcome);
    else w.resolve(await this.inner.append(w.ref, w.req));
    // Let the room's continuation run before the caller looks.
    await new Promise((r) => setImmediate(r));
    return w.req;
  }

  read(ref: DocRef, fromSeq?: number, toSeq?: number): Promise<LogCommit[]> {
    return this.inner.read(ref, fromSeq, toSeq);
  }

  head(ref: DocRef): ReturnType<LogStore['head']> {
    return this.inner.head(ref);
  }

  /** The head state of the inner store, when it has one (HIS-034 tests read it). */
  state(ref: DocRef): ReturnType<NonNullable<LogStore['state']>> {
    if (!this.inner.state) throw new Error('the inner log store has no head state');
    return this.inner.state(ref);
  }
}

/** Waits until `check` holds, polling. */
export async function until(
  check: () => boolean,
  timeoutMs = 3000,
  what = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
