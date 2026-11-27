/**
 * The target under attack (SEC-002, packet F brief): the real document service started in process
 * with both memory storage and PostgreSQL, with two registered tenants so cross-tenant attacks
 * have somewhere to go. The control plane is reached over real HTTP and the data plane over a real
 * WebSocket; the harness mints tokens the way a host does (`POST /tokens`) and forges host-signed
 * ones itself (jws.ts), so attacks are not limited to what the component sends.
 *
 * A suite that needs only the client's half (addresses, tenants, tokens, calls) takes a `Target`.
 * `startHarness` gives one with the service's parts beside it; stack-target.ts gives one for the
 * compose stack of BE-005, a service this process did not start (SEC-002 criterion 5).
 *
 * PostgreSQL comes from the shared integration environment (`infra/test-env.ps1 up -NoExport`);
 * when it is down the PostgreSQL cases skip with the reason. Each PostgreSQL test file gets its own
 * database, migrated by the admin role, which the service role then uses (as the service's own
 * tests do). Only test credentials generated here are used; no real secret (packet F brief).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  configFromEnv,
  createLogger,
  ensureServiceRole,
  hashSecret,
  migrate,
  newApiKey,
  startService,
  type ServiceParts,
  type Service,
} from '@docedit/document-service';
import { createDataPlane as defaultDataPlane } from '../../../../services/document-service/src/data-plane/index.ts';
import type { EventSink } from '../../../../services/document-service/src/control-plane/events.ts';
import { cdmSchema } from '@docedit/model/prosemirror';
import { uuid7 } from '@docedit/model';
import pg from 'pg';
import { startOnFetchablePort } from '../../../../services/document-service/test/support/ports.ts';
import { b64url, keyPair, signJws, type KeyPair } from './jws.ts';

export type Storage = 'memory' | 'postgres';

// ---------------------------------------------------------------------------------------------
// The integration environment, read exactly as services/document-service/test/support/env.ts does.

const CONTAINERS = fileURLToPath(new URL('../../../../infra/containers/', import.meta.url));

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

function settings(): Record<string, string> {
  const s = { ...readEnvFile(CONTAINERS + '.env.example'), ...readEnvFile(CONTAINERS + '.env') };
  for (const k of Object.keys(s)) {
    const v = process.env[k];
    if (v) s[k] = v;
  }
  return s;
}

const S = settings();
const need = (k: string): string => {
  const v = S[k];
  if (!v) throw new Error(`${k} is not set (infra/containers/.env.example)`);
  return v;
};

const ADMIN: pg.ClientConfig = {
  host: need('DOCEDIT_PG_HOST'),
  port: Number(need('DOCEDIT_PG_PORT')),
  user: need('DOCEDIT_PG_ADMIN_USER'),
  password: need('DOCEDIT_PG_ADMIN_PASSWORD'),
  database: 'postgres',
  connectionTimeoutMillis: 3000,
};
const SERVICE_USER = need('DOCEDIT_PG_SERVICE_USER');
const SERVICE_PASSWORD = need('DOCEDIT_PG_SERVICE_PASSWORD');

let probed: Promise<string | null> | undefined;

/** Null when PostgreSQL answers; otherwise the reason the integration cases skip. */
export function postgresUnavailable(): Promise<string | null> {
  probed ??= (async () => {
    const c = new pg.Client({ ...ADMIN, connectionTimeoutMillis: 1500 });
    try {
      await c.connect();
      const r = await c.query<{ v: string }>("SELECT current_setting('server_version_num') AS v");
      const v = Number(r.rows[0]?.v ?? 0);
      return v < 160000 ? `PostgreSQL ${v} is older than 16` : null;
    } catch (e) {
      return `PostgreSQL is not reachable at ${ADMIN.host}:${ADMIN.port} (${
        e instanceof Error ? e.message : String(e)
      }); start it with: pwsh -NoProfile -File infra/test-env.ps1 up -NoExport`;
    } finally {
      await c.end().catch(() => {});
    }
  })();
  return probed;
}

export interface TestDatabase {
  name: string;
  admin: pg.Pool;
  url: string;
  drop(): Promise<void>;
}

/** A new database, migrated by the admin role, usable by the service role. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `docedit_sec_${randomBytes(6).toString('hex')}`;
  const root = new pg.Client(ADMIN);
  await root.connect();
  try {
    await root.query("SELECT pg_advisory_lock(hashtext('docedit.test-roles'))");
    try {
      await ensureServiceRole(root, SERVICE_USER, SERVICE_PASSWORD);
    } finally {
      await root.query("SELECT pg_advisory_unlock(hashtext('docedit.test-roles'))");
    }
    await root.query(`CREATE DATABASE ${name}`);
  } finally {
    await root.end();
  }
  const admin = new pg.Pool({ ...ADMIN, database: name, max: 2 });
  admin.on('error', () => {});
  const c = await admin.connect();
  try {
    await migrate(c);
  } finally {
    c.release();
  }
  const url = `postgres://${SERVICE_USER}:${SERVICE_PASSWORD}@${ADMIN.host}:${ADMIN.port}/${name}`;
  return {
    name,
    admin,
    url,
    async drop() {
      await admin.end().catch(() => {});
      const r = new pg.Client(ADMIN);
      await r.connect();
      try {
        await r.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await r.end();
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// A registered tenant with the keys and the origin an attacker will try to misuse.

export interface TestTenant {
  id: string;
  apiKey: string;
  /** The key the host signs user tokens with (05 §3.1). */
  hostKey: KeyPair;
  /** The separate key for service credentials (05 §3.2). */
  serviceKey: KeyPair;
  /** An origin registered for the tenant (10 §3.2). */
  origin: string;
  /** The `kid` the host key is registered under; `host-<tenant>` when absent. */
  hostKid?: string;
  /** The `kid` the service-credential key is registered under; `svc-<tenant>` when absent. */
  serviceKid?: string;
  /** The `iss` the host key is registered for, when the registration names one (05 §3.1). */
  issuer?: string;
}

export interface CallResult {
  status: number;
  headers: Headers;
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- bodies of many shapes
  json: any;
}

/**
 * What the adversarial client needs of a service under attack, whether it runs in this process
 * (`startHarness`) or is already running, as the compose stack of BE-005 is (stack-target.ts;
 * SEC-002 criterion 5). A suite written against `Target` runs against either.
 */
export interface Target {
  base: string;
  wsUrl: string;
  /** The service identifier every token's `aud` must equal (05 §3.1). */
  serviceId: string;
  /** Two tenants: `a` is the victim, `b` the attacker in cross-tenant tests. */
  a: TestTenant;
  b: TestTenant;
  now(): number;

  /** A host-signed user token (05 §3.1), with sane defaults the caller overrides. */
  userToken(
    tenant: TestTenant,
    sub: string,
    docs: Record<string, string>,
    opts?: {
      header?: Record<string, unknown>;
      claims?: Record<string, unknown>;
      sign?: KeyPair;
      /** For HS256 confusion: the HMAC key (05 §3.1 allows only asymmetric algorithms). */
      hmacKey?: string | Buffer;
    },
  ): string;
  /** A service-minted token through `POST /tokens` (05 §3.1 "service-minted"), as a host mints it. */
  mintToken(
    tenant: TestTenant,
    sub: string,
    docs: Record<string, string>,
    extra?: Record<string, unknown>,
  ): Promise<string>;
  /** A service JWT (`dep-svc+jwt`) signed with a chosen key (05 §3.2). */
  serviceJwt(tenant: TestTenant, claims?: Record<string, unknown>, sign?: KeyPair): string;

  call(
    method: string,
    path: string,
    opts?: { token?: string; body?: unknown; headers?: Record<string, string>; raw?: string },
  ): Promise<CallResult>;
  /** Creates a document for a tenant with the service credential; returns its identifier. */
  createDocument(tenant: TestTenant, content?: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

/** The target started in this process, with the parts of the service a test may reach into. */
export interface Harness extends Target {
  storage: Storage;
  service: Service;
  parts: ServiceParts;
  db: TestDatabase | null;
  /** Every structured log line the service wrote (SEC-047). */
  logs: string[];
}

/**
 * The client's own half of a target: the tokens it forges and the calls it makes. Nothing here
 * reaches into the service, so the same code attacks a service that is already running.
 */
export function clientFor(
  base: string,
  serviceId: string,
  now: () => number,
): Pick<Target, 'userToken' | 'mintToken' | 'serviceJwt' | 'call' | 'createDocument'> {
  const call: Target['call'] = async (method, path, o = {}) => {
    // One connection for each call. A pooled keep-alive connection that has sat idle while the
    // event loop was busy (SEC-028 measures a loop under attack, for longer than the server's
    // 5 second keep-alive timeout) can be closed by the server as the next call is sent on it,
    // which fails with ECONNRESET and says nothing about the service under test.
    const headers: Record<string, string> = { connection: 'close', ...(o.headers ?? {}) };
    if (o.token) headers['Authorization'] = `Bearer ${o.token}`;
    let body: string | undefined = o.raw;
    if (o.body !== undefined) {
      body = JSON.stringify(o.body);
      headers['Content-Type'] ??= 'application/json';
    }
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      /* not JSON */
    }
    return { status: res.status, headers: res.headers, text, json };
  };
  return {
    userToken(tenant, sub, docs, o = {}) {
      const iat = Math.floor(now() / 1000);
      const header = {
        alg: tenant.hostKey.alg,
        typ: 'JWT',
        kid: tenant.hostKid ?? `host-${tenant.id}`,
        ...o.header,
      };
      const claims = {
        iss: tenant.issuer ?? 'https://host.example.test',
        aud: serviceId,
        iat,
        exp: iat + 600,
        jti: uuid7(),
        tid: tenant.id,
        sub,
        docs,
        ...o.claims,
      };
      const sign = o.sign ?? tenant.hostKey;
      return signJws(header, claims, {
        key: sign.privateKey,
        ...(o.hmacKey !== undefined ? { hmacKey: o.hmacKey } : {}),
      });
    },
    async mintToken(tenant, sub, docs, extra = {}) {
      const r = await call('POST', '/v1/tokens', {
        token: tenant.apiKey,
        body: { sub, docs, ...extra },
      });
      if (r.status !== 200) throw new Error(`mint failed: ${r.status} ${r.text}`);
      return r.json.token as string;
    },
    serviceJwt(tenant, claims = {}, sign = tenant.serviceKey) {
      const iat = Math.floor(now() / 1000);
      return signJws(
        { alg: sign.alg, typ: 'dep-svc+jwt', kid: tenant.serviceKid ?? `svc-${tenant.id}` },
        {
          iss: 'host-backend',
          aud: serviceId,
          iat,
          exp: iat + 300,
          jti: uuid7(),
          tid: tenant.id,
          ...claims,
        },
        { key: sign.privateKey },
      );
    },
    call,
    async createDocument(tenant, content) {
      const r = await call('POST', '/v1/documents', {
        token: tenant.apiKey,
        body: content ? { content } : {},
      });
      if (r.status !== 201) throw new Error(`create failed: ${r.status} ${r.text}`);
      return r.json.id as string;
    },
  };
}

/**
 * Registers a new tenant with a host key, a service-credential key, an API key and one origin, as
 * an operator would. The registry is the service's own: in process, or over the database of a
 * service that is already running (stack-target.ts). `apiKeyId` lets the caller withdraw the key.
 */
export async function registerTenant(
  registry: ServiceParts['registry'],
  origin: string,
): Promise<TestTenant & { apiKeyId: string }> {
  const id = randomUUID();
  await registry.putTenant(id, `tenant ${id}`);
  const hostKey = keyPair('EdDSA');
  await registry.addKey(id, {
    kid: `host-${id}`,
    use: 'user',
    alg: 'EdDSA',
    jwk: hostKey.jwk,
  });
  const serviceKey = keyPair('ES256');
  await registry.addKey(id, {
    kid: `svc-${id}`,
    use: 'service',
    alg: 'ES256',
    jwk: serviceKey.jwk,
  });
  const api = newApiKey(id);
  await registry.addApiKey(id, { id: api.id, secretHash: hashSecret(api.secret) });
  await registry.addOrigin(id, origin);
  return { id, apiKey: api.credential, hostKey, serviceKey, origin, apiKeyId: api.id };
}

export interface HarnessOptions {
  /** Replaces the service's storage parts (SEC-031 shares one store between two nodes). */
  parts?: Partial<ServiceParts>;
  /** The node identifier for ownership claims (06 §2.1). */
  node?: string;
  databaseUrl?: string | null;
  /** Read restrictions (ADR 0019, SEC-064): absent, every reader is in the full class. */
  views?: NonNullable<Parameters<typeof startService>[0]['views']>;
  /**
   * Data-plane settings that override the defaults (SEC-018, SEC-031): short lease durations,
   * small send queues and socket high-water marks, tight rate limits. The default data plane is
   * used with them, so the code under attack is the code that ships.
   */
  dataPlane?: Record<string, unknown>;
  /** The event sink of the service (PRM-053): webhook events and the data plane's refusals go here. */
  events?: EventSink;
  /** The listening port (U-SEC-001-016, SEC-014 restart): 0 picks a free one. */
  port?: number;
  /**
   * The listening host (U-SEC-017-032, SEC-018): `0.0.0.0` accepts loopback clients from other
   * 127.x.x.x source addresses. The harness's own URL then names 127.0.0.1, which Windows connects to.
   */
  host?: string;
  /**
   * The node's rate limits (U-SEC-017-032, SEC-018). `dataPlane.rates` is not read when this is
   * absent, since the server builds the shared limits from its defaults; pass them here instead.
   */
  rateLimits?: StartOptionsRateLimits;
  /** DOCEDIT_* variables read by `configFromEnv` (PRM-053: `DOCEDIT_WEBHOOKS` and its settings). */
  env?: Record<string, string>;
  /** With `DOCEDIT_WEBHOOKS`: a recording transport or a delivery store the test reads (PRM-053). */
  webhooks?: NonNullable<Parameters<typeof startService>[0]['webhooks']>;
  /** Finished request spans (SEC-047 criterion 1, traces): a test records them here. */
  onSpan?: NonNullable<Parameters<typeof startService>[0]['onSpan']>;
  /**
   * Called each time the data plane asks for a token to be verified (SEC-018 criterion 1): a test
   * counts the verification work a flood costs. The real verifier still runs.
   */
  onVerify?: () => void;
  /** Job handlers in process (SEC-007): with an `export` handler the service announces `exports`. */
  jobHandlers?: NonNullable<Parameters<typeof startService>[0]['jobHandlers']>;
  /** The asset worker in process (SEC-007): with it the service announces `assets`. */
  assetWorker?: NonNullable<Parameters<typeof startService>[0]['assetWorker']>;
  /** A Word importer (SEC-005 criterion 4): with it the service offers `/imports` and runs the job. */
  importer?: NonNullable<Parameters<typeof startService>[0]['importer']>;
}

type StartOptionsRateLimits = NonNullable<Parameters<typeof startService>[0]['rateLimits']>;

export async function startHarness(storage: Storage, opts: HarnessOptions = {}): Promise<Harness> {
  let db: TestDatabase | null = null;
  let databaseUrl = opts.databaseUrl ?? null;
  if (storage === 'postgres' && databaseUrl === null) {
    db = await createTestDatabase();
    databaseUrl = db.url;
  }
  const now = () => Date.now();
  const logs: string[] = [];
  const logger = createLogger((line) => logs.push(line));
  const start = () =>
    startService({
      config: {
        ...configFromEnv(opts.env ?? {}),
        port: opts.port ?? 0,
        ...(opts.host ? { host: opts.host } : {}),
        workers: 1,
        databaseUrl,
        ...(opts.node ? { node: opts.node } : {}),
      },
      ...(opts.parts ? { parts: opts.parts } : {}),
      ...(opts.views ? { views: opts.views } : {}),
      ...(opts.rateLimits ? { rateLimits: opts.rateLimits } : {}),
      ...(opts.events ? { events: opts.events } : {}),
      ...(opts.webhooks ? { webhooks: opts.webhooks } : {}),
      ...(opts.dataPlane || opts.onVerify
        ? {
            createDataPlane: (deps: Parameters<typeof defaultDataPlane>[0]) => {
              const verify = deps.verify as (...args: unknown[]) => unknown;
              return defaultDataPlane({
                ...deps,
                ...(opts.onVerify
                  ? {
                      verify: (...args: unknown[]) => {
                        opts.onVerify?.();
                        return verify(...args);
                      },
                    }
                  : {}),
                settings: { ...deps.settings, ...(opts.dataPlane ?? {}) },
              } as Parameters<typeof defaultDataPlane>[0]);
            },
          }
        : {}),
      ...(opts.onSpan ? { onSpan: opts.onSpan } : {}),
      ...(opts.jobHandlers ? { jobHandlers: opts.jobHandlers } : {}),
      ...(opts.assetWorker ? { assetWorker: opts.assetWorker } : {}),
      ...(opts.importer ? { importer: opts.importer } : {}),
      logger,
      now,
    });
  // A port the system chooses can be one fetch refuses ("bad port"); choose again then.
  const service =
    (opts.port ?? 0) === 0
      ? await startOnFetchablePort(
          start,
          (s) => s.url,
          (s) => s.close(),
        )
      : await start();
  if (opts.host === '0.0.0.0') {
    // Windows does not connect to 0.0.0.0; the same listener answers on 127.0.0.1.
    (service as { url: string }).url = service.url.replace('//0.0.0.0:', '//127.0.0.1:');
  }
  const serviceId = service.url;
  const a: TestTenant = await registerTenant(service.parts.registry, 'https://app-a.example.test');
  const b: TestTenant = await registerTenant(service.parts.registry, 'https://app-b.example.test');
  const wsUrl = `${service.url.replace(/^http/, 'ws')}/dep`;

  const h: Harness = {
    storage,
    service,
    parts: service.parts,
    base: service.url,
    wsUrl,
    serviceId,
    a,
    b,
    db,
    logs,
    now,
    ...clientFor(service.url, serviceId, now),
    async close() {
      await service.close();
      await db?.drop();
    },
  };
  return h;
}

// ---------------------------------------------------------------------------------------------
// Content fixtures (03 §4.2): a body paragraph, a restricted region, an inherit region.

/** A CDM envelope with two regions, so a doc-level editor still lacks edit in the restricted one. */
export function documentWithRegions(): Record<string, unknown> {
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
        {
          type: 'body',
          attrs: { pageSetup: 'ps1' },
          content: [
            {
              type: 'paragraph',
              attrs: { id: 'pIntro0000000001', style: 'Normal' },
              content: [{ type: 'text', text: 'Hello' }],
            },
            {
              type: 'region',
              attrs: { id: 'rLegal0000000001', title: 'Legal review', policy: 'restricted' },
              content: [
                {
                  type: 'paragraph',
                  attrs: { id: 'pLegal0000000001', style: 'Normal' },
                  content: [{ type: 'text', text: 'Liability' }],
                },
              ],
            },
            {
              type: 'region',
              attrs: { id: 'rOpen00000000001', title: 'Open part', policy: 'inherit' },
              content: [{ type: 'paragraph', attrs: { id: 'pOpen00000000001', style: 'Normal' } }],
            },
            { type: 'paragraph', attrs: { id: 'pEnd000000000001', style: 'Normal' } },
          ],
        },
      ],
    },
  };
}

/** The position just inside the paragraph with `id` in a CDM `doc`, for a `replace` step. */
export function posInside(docJson: unknown, id: string): number {
  let pos = -1;
  cdmSchema()
    .nodeFromJSON(docJson)
    .descendants((n, p) => {
      if (n.attrs['id'] === id) pos = p + 1;
      return pos < 0;
    });
  if (pos < 0) throw new Error(`no node ${id}`);
  return pos;
}

/** The position of the node with `id` itself (its opening boundary). */
export function posOf(docJson: unknown, id: string): number {
  let pos = -1;
  cdmSchema()
    .nodeFromJSON(docJson)
    .descendants((n, p) => {
      if (n.attrs['id'] === id) pos = p;
      return pos < 0;
    });
  if (pos < 0) throw new Error(`no node ${id}`);
  return pos;
}

/** A `replace` step that inserts `text` at `pos` (prosemirror-transform ReplaceStep JSON). */
export function insertText(pos: number, text: string): Record<string, unknown> {
  return { stepType: 'replace', from: pos, to: pos, slice: { content: [{ type: 'text', text }] } };
}

export { b64url };
