/**
 * The control plane as tests reach it: an in-process service on a free port, called over real
 * HTTP, with in-memory or PostgreSQL storage (FND-010), a registered tenant with a host key for user
 * tokens, a service key and an API key, all generated here (test values only), and a stub data plane
 * that records what the control plane tells the rooms.
 */
import { generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { PermissionState } from '@docedit/authority';
import { uuid7 } from '@docedit/model';
import type { Notification } from '@docedit/protocol';
import { configFromEnv, type ServiceConfig } from '../../src/config.ts';
import { MemoryEventSink } from '../../src/control-plane/events.ts';
import type { JobHandler } from '../../src/control-plane/jobs/runner.ts';
import { b64url, signJws, type Algorithm, type PublicJwk } from '../../src/control-plane/jwt.ts';
import { hashSecret } from '../../src/control-plane/tenants.ts';
import { newApiKey, signingKey } from '../../src/control-plane/tokens.ts';
import type { DataPlane, DataPlaneDeps } from '../../src/seams.ts';
import type { Views } from '../../src/control-plane/visibility.ts';
import {
  memoryParts,
  pgParts,
  startService,
  type Service,
  type ServiceParts,
  type StartOptions,
} from '../../src/server.ts';
import type { DocRef } from '../../src/storage/types.ts';
import { createTestDatabase, postgresUnavailable, type TestDatabase } from '../support/env.ts';
import { startOnFetchablePort } from '../support/ports.ts';

export type Storage = 'memory' | 'postgres';

export interface Notice {
  kind: 'permissions' | 'document' | 'revoked' | 'upgrade' | 'notify';
  ref?: DocRef;
  perms?: PermissionState;
  user?: string;
  doc?: string | null;
  /** For `notify`: the notification (05 §5.6). */
  notification?: Notification;
  /** For `notify`: the scopes the notification is about, when the sender named them. */
  scopes?: readonly string[];
}

/** A data plane that records the control plane's notifications (BE-026 is the real side). */
export class StubDataPlane implements DataPlane {
  readonly notices: Notice[] = [];
  deps: DataPlaneDeps | null = null;
  readonly features = ['presence', 'regions', 'suggest-enforced'];
  handleUpgrade(_req: IncomingMessage, socket: Duplex): void {
    this.notices.push({ kind: 'upgrade' });
    socket.end('HTTP/1.1 418 Stub\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  }
  permissionsChanged(ref: DocRef, perms: PermissionState): void {
    this.notices.push({ kind: 'permissions', ref, perms });
  }
  documentChanged(ref: DocRef): void {
    this.notices.push({ kind: 'document', ref });
  }
  /** Set by a test to stand in for the data plane's snapshot commits (BE-037). */
  replaceContent?: NonNullable<DataPlane['replaceContent']>;
  /** Set by a test to stand in for the data plane's pages of the log (BE-038). */
  readCommits?: NonNullable<DataPlane['readCommits']>;
  /** Records the notifications the control plane sends to channels (05 §5.6; PRO-035). */
  notify(
    ref: DocRef,
    notification: Notification,
    opts?: { user?: string; scopes?: readonly string[] },
  ): void {
    this.notices.push({
      kind: 'notify',
      ref,
      notification,
      ...(opts?.user ? { user: opts.user } : {}),
      ...(opts?.scopes ? { scopes: opts.scopes } : {}),
    });
  }
  sessionsRevoked(_tenant: string, user: string, doc: string | null): void {
    this.notices.push({ kind: 'revoked', user, doc });
  }
  async close(): Promise<void> {}
}

export interface HostKey {
  kid: string;
  alg: Algorithm;
  privateKey: KeyObject;
  jwk: PublicJwk;
}

export function hostKey(alg: Algorithm = 'EdDSA', kid = `k-${randomUUID()}`): HostKey {
  const pair =
    alg === 'EdDSA'
      ? generateKeyPairSync('ed25519')
      : alg === 'ES256'
        ? generateKeyPairSync('ec', { namedCurve: 'P-256' })
        : generateKeyPairSync('rsa', { modulusLength: 2048 });
  const exported = pair.publicKey.export({ format: 'jwk' }) as Record<string, string>;
  const jwk: PublicJwk =
    alg === 'EdDSA'
      ? { kty: 'OKP', crv: 'Ed25519', x: exported['x']! }
      : alg === 'ES256'
        ? { kty: 'EC', crv: 'P-256', x: exported['x']!, y: exported['y']! }
        : { kty: 'RSA', n: exported['n']!, e: exported['e']! };
  return { kid, alg, privateKey: pair.privateKey, jwk };
}

export interface CallResult {
  status: number;
  headers: Headers;
  text: string;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- response bodies of many shapes
}

export interface Harness {
  storage: Storage;
  /** The test database (PostgreSQL only): its admin pool can inspect storage. */
  db: TestDatabase | null;
  service: Service;
  parts: ServiceParts;
  /** The base URL; REST is under `/v1`. */
  base: string;
  tenant: string;
  serviceId: string;
  apiKey: string;
  host: HostKey;
  serviceKey: HostKey;
  stub: StubDataPlane;
  events: MemoryEventSink;
  /** The service clock; `advance` moves it, and for PostgreSQL the job queue's times with it. */
  now(): number;
  advance(ms: number): void;
  /** A host-signed user token (05 §3.1) with sane defaults that `claims` override. */
  userToken(docs: Record<string, string>, claims?: Record<string, unknown>, key?: HostKey): string;
  /** A service JWT (`dep-svc+jwt`) signed with the tenant's service key. */
  serviceJwt(claims?: Record<string, unknown>, key?: HostKey): string;
  call(
    method: string,
    path: string,
    opts?: { token?: string; body?: unknown; headers?: Record<string, string>; raw?: string },
  ): Promise<CallResult>;
  /** Creates a document with the API key and returns its identifier. */
  createDocument(body?: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

/** Why PostgreSQL tests skip, or null. */
export async function skipReason(storage: Storage): Promise<string | null> {
  return storage === 'postgres' ? postgresUnavailable() : null;
}

export async function startHarness(
  storage: Storage,
  opts: {
    config?: Partial<ServiceConfig>;
    jobHandlers?: Readonly<Record<string, JobHandler>>;
    parts?: Partial<ServiceParts>;
    allowWorkerCrash?: boolean;
    views?: Views;
    /** The asset worker in process (PRO-061): `{ sandbox: unsandboxed(), allowUnsandboxed: true }`. */
    assetWorker?: StartOptions['assetWorker'];
    fonts?: StartOptions['fonts'];
    /** Logs and spans of the request pipeline, for the PRO-044 tests. */
    logger?: StartOptions['logger'];
    onSpan?: StartOptions['onSpan'];
    /** The node's rate limits (BE-030): the REST pipeline and the stub data plane share them. */
    rateLimits?: StartOptions['rateLimits'];
    /** The real data plane (BE-079 idle test) instead of the stub; the stub is the default. */
    realDataPlane?: boolean;
    /** Overrides of the composed webhook dispatcher (`config.webhooks` set); its dispatcher is the sink. */
    webhooks?: StartOptions['webhooks'];
  } = {},
): Promise<Harness> {
  let offset = 0;
  const now = () => Date.now() + offset;
  /** The last move of the PostgreSQL jobs' times by `advance`; `call` waits for it. */
  let shifted: Promise<void> = Promise.resolve();
  let db: TestDatabase | null = null;
  let parts: ServiceParts;
  if (storage === 'postgres') {
    db = await createTestDatabase();
    parts = pgParts(db.service);
  } else parts = memoryParts(now);
  Object.assign(parts, opts.parts ?? {});
  const stub = new StubDataPlane();
  const events = new MemoryEventSink();
  const config: ServiceConfig = {
    ...configFromEnv({}),
    port: 0,
    workers: 1,
    ...opts.config,
  };
  const start = () =>
    startService({
      config,
      parts,
      // With `config.webhooks` the composed dispatcher is the sink, and the two are exclusive.
      ...(config.webhooks ? {} : { events }),
      ...(opts.webhooks ? { webhooks: opts.webhooks } : {}),
      now,
      signing: signingKey(undefined, 'service-test'),
      ...(opts.realDataPlane
        ? {}
        : {
            createDataPlane: (deps: DataPlaneDeps) => {
              stub.deps = deps;
              return stub;
            },
          }),
      ...(opts.jobHandlers ? { jobHandlers: opts.jobHandlers } : {}),
      ...(opts.allowWorkerCrash ? { allowWorkerCrash: true } : {}),
      ...(opts.views ? { views: opts.views } : {}),
      ...(opts.assetWorker !== undefined ? { assetWorker: opts.assetWorker } : {}),
      ...(opts.fonts ? { fonts: opts.fonts } : {}),
      ...(opts.logger ? { logger: opts.logger } : {}),
      ...(opts.onSpan ? { onSpan: opts.onSpan } : {}),
      ...(opts.rateLimits ? { rateLimits: opts.rateLimits } : {}),
    });
  // Port 0 can land on a port fetch refuses (`bad port`); the service is started again until it
  // does not. A port the test names is kept as it is.
  const service =
    config.port === 0
      ? await startOnFetchablePort(
          start,
          (s) => s.url,
          (s) => s.close(),
        )
      : await start();
  const tenant = randomUUID();
  await parts.registry.putTenant(tenant, 'Test tenant');
  const host = hostKey('EdDSA');
  await parts.registry.addKey(tenant, { kid: host.kid, use: 'user', alg: host.alg, jwk: host.jwk });
  const serviceKey = hostKey('ES256');
  await parts.registry.addKey(tenant, {
    kid: serviceKey.kid,
    use: 'service',
    alg: serviceKey.alg,
    jwk: serviceKey.jwk,
  });
  const key = newApiKey(tenant);
  await parts.registry.addApiKey(tenant, { id: key.id, secretHash: hashSecret(key.secret) });
  await parts.registry.addOrigin(tenant, 'https://app.example.test');
  const serviceId = service.url;

  const h: Harness = {
    storage,
    db,
    service,
    parts,
    base: service.url,
    tenant,
    serviceId,
    apiKey: key.credential,
    host,
    serviceKey,
    stub,
    events,
    now,
    advance: (ms) => {
      offset += ms;
      // The PostgreSQL job queue keeps the database's clock (06 §2.1), which a test cannot move.
      // The jobs' times are moved back instead, the same as that clock moving forward for the
      // queue: a waiting job becomes due as it does in memory. `call` waits for the update.
      if (db) {
        const admin = db.admin;
        const by = `${Math.max(0, Math.round(ms))} milliseconds`;
        shifted = shifted.then(async () => {
          await admin.query(
            `UPDATE jobs SET created_at = created_at - $1::interval,
                             run_after = CASE WHEN state = 'queued'
                                              THEN run_after - $1::interval ELSE run_after END`,
            [by],
          );
        });
      }
    },
    userToken(docs, claims = {}, k = host) {
      const iat = Math.floor(now() / 1000);
      return signJws(
        { alg: k.alg, typ: 'JWT', kid: k.kid },
        {
          iss: 'https://host.example.test',
          aud: serviceId,
          iat,
          exp: iat + 600,
          jti: uuid7(),
          tid: tenant,
          sub: 'alice',
          docs,
          ...claims,
        },
        k.privateKey,
      );
    },
    serviceJwt(claims = {}, k = serviceKey) {
      const iat = Math.floor(now() / 1000);
      return signJws(
        { alg: k.alg, typ: 'dep-svc+jwt', kid: k.kid },
        {
          iss: 'host-backend',
          aud: serviceId,
          iat,
          exp: iat + 300,
          jti: uuid7(),
          tid: tenant,
          ...claims,
        },
        k.privateKey,
      );
    },
    async call(method, path, o = {}) {
      await shifted;
      const headers: Record<string, string> = { ...(o.headers ?? {}) };
      if (o.token) headers['Authorization'] = `Bearer ${o.token}`;
      let body: string | undefined = o.raw;
      if (o.body !== undefined) {
        body = JSON.stringify(o.body);
        headers['Content-Type'] ??= 'application/json';
      }
      const res = await fetch(`${service.url}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
      });
      const text = await res.text();
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        // Not JSON: the body is in text.
      }
      return { status: res.status, headers: res.headers, text, json };
    },
    async createDocument(body = {}) {
      const r = await h.call('POST', '/v1/documents', { token: h.apiKey, body });
      if (r.status !== 201) throw new Error(`create failed: ${r.status} ${r.text}`);
      return r.json.id as string;
    },
    async close() {
      await shifted.catch(() => undefined);
      await service.close();
      await db?.drop();
    },
  };
  return h;
}

/** A CDM envelope with one region, for grants and regions (03 §4.2). */
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

export const b64 = b64url;
