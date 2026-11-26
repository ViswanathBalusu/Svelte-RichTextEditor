/**
 * Settings of the document service process (BE-001), from the environment. Every number here is a
 * setting with a default, not a measurement; ADR 0036 and ADR 0054 list them. The figures the spec
 * gives are cited where they apply.
 */
import { hostname } from 'node:os';
import { CLASS_VERSION } from '@docedit/export-latex';
import { LIMITS } from '@docedit/model/validate';
import type { S3Settings } from './objects/s3.ts';
import type { AzureBlobSettings } from './objects/azure.ts';

/** Where the service runs. Test mode (BE-079) is refused in `production`, the default. */
export type Environment = 'production' | 'development' | 'test';

export interface ServiceConfig {
  host: string;
  /** 0 picks a free port (tests). */
  port: number;
  /** The public base URL of the endpoint (05 §8.1 `endpoint`); discovery is under it. */
  publicUrl: string | null;
  /** The service identifier: the `aud` of every token and the `iss` of minted ones (05 §3.1). */
  serviceId: string | null;
  /** The service role's connection string; null runs on in-memory storage (development, tests). */
  databaseUrl: string | null;
  /** The S3-compatible store; null keeps objects in memory. */
  s3: S3Settings | null;
  /** The Azure Blob store (BE-004), chosen when DOCEDIT_AZURE_ACCOUNT is set; null otherwise. */
  azure: AzureBlobSettings | null;
  /** The private JWK that signs minted tokens; null draws a key for the life of the process. */
  signingJwk: Record<string, unknown> | null;
  /** A JSON seed of tenant registrations applied at start (BE-012). */
  tenantsFile: string | null;
  /**
   * Features announced in discovery and `welcome` (05 §2); null: the data plane's own features,
   * and `exports` of the control plane when a compile worker can serve them (ADR 0054).
   */
  features: string[] | null;
  /**
   * The rebase window in steps (`maxRebaseSteps`, 04 §12): how far behind the head a commit or a
   * thread's `baseSeq` may be. Null keeps the protocol default; a test sets a small one.
   */
  maxRebaseSteps: number | null;
  /** The key of view tokens, shared by both planes (ADR 0019 change 1); null draws one. */
  viewKey: Uint8Array | null;
  /** Export targets the compile worker supports (PRO-063). */
  exportTargets: string[];
  /** This node's identifier for ownership claims (06 §2.1). */
  node: string;
  /**
   * The WebSocket URL that clients of other nodes are told to use for this node, written on its
   * lease row (BE-061; owner decision 200). Default none: the node then announces no address and
   * `GET /documents/{id}/connect` answers with the address of the service itself.
   */
  nodeAddress: string | null;
  /**
   * The region this node runs in, written on its lease row (BE-074). A tenant with a home region
   * is served by the nodes of that region only. Default none: the node is in no region.
   */
  nodeRegion: string | null;
  /**
   * The one document this node is dedicated to, written on its lease row (BE-073). The node then
   * serves that document only, and other nodes route it here. Default none: a general node.
   */
  dedicatedDocument: string | null;
  workers: number;
  workerTimeoutMs: number;
  maxBodyBytes: number;
  maxContentBodyBytes: number;
  signedUrlSeconds: number;
  /** Key of the list cursors; null draws one per process (cursors then end with it). */
  cursorSecret: Uint8Array | null;
  /** Entries of the content caches. */
  rebuiltEntries: number;
  responseEntries: number;
  jobLeaseMs: number;
  jobIdleMs: number;
  jobRetryAfterMs: number;
  // --- Phase 1b (packet C; ADR 0054). ------------------------------------------------------------
  environment: Environment;
  /** Fault-injection hooks and shortened timers for the conformance kit (BE-079). */
  testMode: boolean;
  /** 05 §6.1: idempotency keys are remembered for 24 hours. */
  idempotencyTtlMs: number;
  /** How long a request waits for the first one with its key. */
  idempotencyWaitMs: number;
  /** `Retry-After` of `unavailable` problems, seconds. */
  unavailableRetryAfterS: number;
  /** The bearer secret that `/metrics` takes; null: no metrics endpoint. */
  metricsToken: string | null;
  /**
   * Redis or Valkey for the tenant and user rate-limit counters (BE-030 stage 2, BE-063; for example
   * `redis://host:6379`). Null: the counters are in this process's memory (stage 1). Only counters
   * live there; a lost or unreachable store loosens limits and never loses data.
   */
  valkeyUrl: string | null;
  /**
   * A read replica of the database (BE-064): lists, pinned content and history reads are served
   * from it when it can answer them correctly. Default none: every read goes to the primary.
   */
  replicaDatabaseUrl: string | null;
  /**
   * A login that is a member of `docedit_purge` (migration 0073), for the scheduled purge of deleted
   * documents (HIS-039; PRO-047 criterion 4) and the move of old commit payloads to cold segments
   * (HIS-029). Null: neither task runs. The service role cannot delete the log, so these tasks
   * connect as a role of their own.
   */
  purgeDatabaseUrl: string | null;
  /**
   * Read-your-writes sessions kept, with a replica (BE-064 criterion 3). A setting with no default:
   * a replica without it is refused at start.
   */
  readSessions: number | null;
  /** Documents whose replica lag is sampled at each metrics scrape (BE-064 criterion 4); default none. */
  readLagDocuments: number | null;
  /** A font set with the converter's `fonts.json` (PRO-067, BE-047); null: no fonts. */
  fontsDir: string | null;
  /** Where the font files are served; default `{publicUrl}/fonts`. */
  fontsBaseUrl: string | null;
  /** The separate origin of the asset worker (10 §3.5); null: object-store URLs. */
  assetOrigin: string | null;
  /** The URL key of the asset origin: `<id>:<base64 secret of at least 32 bytes>`. */
  assetUrlKey: string | null;
  /** Lifetime of pre-signed uploads, seconds. */
  uploadSeconds: number;
  /** Days between the soft delete of a document and its purge (HIS-039; owner decision 30). */
  purgeAfterDays: number;
  /**
   * Days after which a commit payload moves from PostgreSQL to a cold segment in object storage
   * (HIS-029; 08 §11 and 06 §10: 30). The move runs only with `purgeDatabaseUrl`.
   */
  coldAfterDays: number;
  /**
   * Days an anchor record of chain heads is retained in write-once storage (HIS-036; ADR 0409).
   * Null: no head is anchored. There is no default, because the spec gives no retention; the
   * anchoring also needs the signing service of `sealing` and a write-once store.
   */
  anchorRetentionDays: number | null;
  /** Run the asset worker in this process with its Podman sandbox. */
  assetWorker: boolean;
  /** 06 §10: at most one preview compile per document in this window. */
  previewWindowMs: number;
  /** How old an export result may be to answer a new request (EXP-006). */
  exportCacheMaxAgeMs: number;
  /** The house class version in every export key (EXP-006 criterion 3). */
  exportClassVersion: string;
  /** Running export jobs of a kind per tenant without a limit of its own; null: none. */
  exportTenantConcurrency: number | null;
  /** The key of the queue proof of export jobs (EXP-067 criterion 4); null: none is written. */
  exportProofKey: string | null;
  /**
   * Whether compile and asset workers outside this process serve the queue: with PostgreSQL by
   * default. Without them, and without handlers in the process, `exports` and `assets` are not
   * announced (ADR 0054).
   */
  externalWorkers: boolean;
  /** How long a prefill waits for its commit (FRW-061). */
  outboxWaitMs: number;
  /** Scheduled maintenance (BE-052). */
  scheduler: boolean;
  /**
   * The search index (BE-054): every stored checkpoint queues a job that indexes its words, and
   * `GET /search` is offered to a service credential. Off by default (proposed, ADR 0388).
   * The index copies the words of every document into more tables, which erasure and purge
   * must then reach (HIS-039; SEC-045).
   */
  searchIndex: boolean;
  /**
   * Webhook delivery (05 §7; BE-055, BE-056; PRM-053). Null: no event is delivered to a webhook
   * and `/webhooks` is not offered. Every number here is a setting with no default, because the
   * spec gives none (ADR 0146): `DOCEDIT_WEBHOOKS=true` needs all four of them.
   */
  webhooks: WebhookSettings | null;
  /**
   * The signing service that seals the final PDF (12 §8.2 step 3; FRW-052, FRW-053). Null: no
   * workflow is sealed here and a completed workflow stays `completed`. `DOCEDIT_SEAL_URL` turns it
   * on and then needs the other five settings, which have no default because the spec gives none.
   */
  sealing: SealingSettings | null;
}

/** The settings of the live seal step (server.ts composes it; docs/adr/0412). */
export interface SealingSettings {
  /** Base URL of the signing service. */
  url: string;
  /** The document service's credential for it (a secret: environment only). */
  credential: string;
  /** How long to wait for one answer, ms. */
  timeoutMs: number;
  /** Attempts of one run (at least 1); the waits are `delaysMs`, the last one repeating. */
  attempts: number;
  delaysMs: number[];
  /** How long the stored sealed bytes are retained, days from the seal. */
  retentionDays: number;
  /**
   * The renewal of the seal's time-stamp (12 §8.2 step 5; FRW-056). Absent: no renewal is
   * scheduled. Neither number has a default, as the specification gives none.
   */
  renewal?: {
    /** How long before an expiry the renewal is queued, ms (`DOCEDIT_RENEWAL_LEAD_DAYS`). */
    leadMs: number;
    /** How long a run holds the claim on an expiry, ms (`DOCEDIT_RENEWAL_CLAIM_MS`). */
    claimMs: number;
  };
}

/** The settings of the webhook dispatcher and its egress proxy (server.ts composes them). */
export interface WebhookSettings {
  /** The window of the `dep.commit.rejected` throttle, ms (PRM-053 criterion 5). */
  rejectedWindowMs: number;
  /** `dep.commit.rejected` deliveries admitted per tenant and window. */
  rejectedMax: number;
  /** The timeout of one request to a target, ms (BE-056). */
  timeoutMs: number;
  /** Redirects the egress proxy follows, each checked again (BE-056). */
  maxRedirects: number;
  /** The CloudEvents `source`; null: the service identifier. */
  source: string | null;
  /**
   * The retry schedule of a failed delivery (PRO-071): the delay before the first retry and the
   * growth per attempt. The window is the 24 hours of 05 §7. Absent: a failed delivery is not
   * retried. The spec gives no figure for either, so there is no default (ADR 0216, proposed).
   */
  retry?: { baseMs: number; factor: number };
  /**
   * Test mode only (DOCEDIT_TEST_WEBHOOK_ALLOW, ADR 0316 proposal 2, accepted with owner decisions 196
   * to 220): IP literals that the egress proxy reaches although they are loopback or private, so the
   * conformance kit's receiver can be a target (PRO-121). Refused outside test mode.
   */
  testAllow?: readonly string[];
}

export const DEFAULTS: Omit<ServiceConfig, 'node'> = {
  host: '127.0.0.1',
  port: 8080,
  publicUrl: null,
  serviceId: null,
  databaseUrl: null,
  s3: null,
  azure: null,
  signingJwk: null,
  tenantsFile: null,
  features: null,
  maxRebaseSteps: null,
  viewKey: null,
  exportTargets: ['pdf'],
  nodeAddress: null,
  nodeRegion: null,
  dedicatedDocument: null,
  workers: 2,
  workerTimeoutMs: 60_000,
  maxBodyBytes: 1024 * 1024,
  // 06 §8 and 03: a document is at most 16 MiB in canonical form.
  maxContentBodyBytes: LIMITS.canonicalBytes,
  signedUrlSeconds: 300,
  cursorSecret: null,
  rebuiltEntries: 64,
  responseEntries: 256,
  jobLeaseMs: 30_000,
  jobIdleMs: 1_000,
  jobRetryAfterMs: 5_000,
  environment: 'production',
  testMode: false,
  idempotencyTtlMs: 24 * 60 * 60 * 1000,
  idempotencyWaitMs: 10_000,
  unavailableRetryAfterS: 1,
  metricsToken: null,
  valkeyUrl: null,
  replicaDatabaseUrl: null,
  purgeDatabaseUrl: null,
  readSessions: null,
  readLagDocuments: null,
  fontsDir: null,
  fontsBaseUrl: null,
  assetOrigin: null,
  assetUrlKey: null,
  uploadSeconds: 900,
  purgeAfterDays: 30,
  coldAfterDays: 30,
  anchorRetentionDays: null,
  assetWorker: false,
  previewWindowMs: 10_000,
  exportCacheMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
  exportClassVersion: CLASS_VERSION,
  exportTenantConcurrency: null,
  exportProofKey: null,
  externalWorkers: false,
  outboxWaitMs: 10_000,
  scheduler: true,
  searchIndex: false,
  webhooks: null,
  sealing: null,
};

/** A setting the spec gives no figure for: required, with no default (ADR 0146). */
function required(env: NodeJS.ProcessEnv, name: string, min: number): number {
  const v = env[name];
  if (v === undefined || v === '')
    throw new Error(`DOCEDIT_WEBHOOKS needs ${name}; it has no default`);
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < min)
    throw new Error(`${name} must be an integer of at least ${min}`);
  return n;
}

/**
 * The retry schedule from DOCEDIT_WEBHOOK_RETRY_BASE_MS and DOCEDIT_WEBHOOK_RETRY_FACTOR: both or
 * neither (neither: no retry). Unlike the settings above, leaving them out is allowed, because
 * the owner has not chosen a schedule (ADR 0216).
 */
function retrySettings(env: NodeJS.ProcessEnv): WebhookSettings['retry'] {
  const base = env['DOCEDIT_WEBHOOK_RETRY_BASE_MS'];
  const factor = env['DOCEDIT_WEBHOOK_RETRY_FACTOR'];
  const none = (v: string | undefined) => v === undefined || v === '';
  if (none(base) && none(factor)) return undefined;
  if (none(base) || none(factor))
    throw new Error(
      'DOCEDIT_WEBHOOK_RETRY_BASE_MS and DOCEDIT_WEBHOOK_RETRY_FACTOR are set together or not at all',
    );
  const baseMs = required(env, 'DOCEDIT_WEBHOOK_RETRY_BASE_MS', 1);
  const f = Number(factor);
  if (!Number.isFinite(f) || f < 1)
    throw new Error('DOCEDIT_WEBHOOK_RETRY_FACTOR must be a number of at least 1');
  return { baseMs, factor: f };
}

/** The webhook settings from DOCEDIT_WEBHOOK_* variables, or null when DOCEDIT_WEBHOOKS is off. */
function webhookSettings(env: NodeJS.ProcessEnv): WebhookSettings | null {
  if (!flag(env, 'DOCEDIT_WEBHOOKS', false)) return null;
  const retry = retrySettings(env);
  const testAllow = list(env['DOCEDIT_TEST_WEBHOOK_ALLOW'], []);
  return {
    ...(retry ? { retry } : {}),
    ...(testAllow.length > 0 ? { testAllow } : {}),
    rejectedWindowMs: required(env, 'DOCEDIT_WEBHOOK_REJECTED_WINDOW_MS', 1),
    rejectedMax: required(env, 'DOCEDIT_WEBHOOK_REJECTED_MAX', 1),
    timeoutMs: required(env, 'DOCEDIT_WEBHOOK_TIMEOUT_MS', 1),
    maxRedirects: required(env, 'DOCEDIT_WEBHOOK_MAX_REDIRECTS', 0),
    source: env['DOCEDIT_WEBHOOK_SOURCE'] || null,
  };
}

/** The seal settings from DOCEDIT_SEAL_* variables, or null when DOCEDIT_SEAL_URL is not set. */
function sealingSettings(env: NodeJS.ProcessEnv): SealingSettings | null {
  const url = env['DOCEDIT_SEAL_URL'];
  if (url === undefined || url === '') return null;
  const need = (name: string): string => {
    const v = env[name];
    if (v === undefined || v === '')
      throw new Error(`DOCEDIT_SEAL_URL needs ${name}; it has no default`);
    return v;
  };
  const delays = need('DOCEDIT_SEAL_DELAYS_MS')
    .split(',')
    .map((s) => Number(s.trim()));
  if (delays.some((n) => !Number.isSafeInteger(n) || n < 0))
    throw new Error('DOCEDIT_SEAL_DELAYS_MS is a comma-separated list of non-negative integers');
  const num = (name: string, min: number): number => {
    const n = Number(need(name));
    if (!Number.isSafeInteger(n) || n < min)
      throw new Error(`${name} must be an integer of at least ${min}`);
    return n;
  };
  // The renewal of the time-stamp: both settings or neither (FRW-056).
  const leadDays = env['DOCEDIT_RENEWAL_LEAD_DAYS'];
  const claimMs = env['DOCEDIT_RENEWAL_CLAIM_MS'];
  const wantsRenewal = (leadDays ?? '') !== '' || (claimMs ?? '') !== '';
  return {
    url: url.replace(/\/+$/, ''),
    credential: need('DOCEDIT_SEAL_CREDENTIAL'),
    timeoutMs: num('DOCEDIT_SEAL_TIMEOUT_MS', 1),
    attempts: num('DOCEDIT_SEAL_ATTEMPTS', 1),
    delaysMs: delays,
    retentionDays: num('DOCEDIT_SEAL_RETENTION_DAYS', 1),
    ...(wantsRenewal
      ? {
          renewal: {
            leadMs: num('DOCEDIT_RENEWAL_LEAD_DAYS', 1) * 24 * 60 * 60 * 1000,
            claimMs: num('DOCEDIT_RENEWAL_CLAIM_MS', 1),
          },
        }
      : {}),
  };
}

const list = (v: string | undefined, fallback: string[]) =>
  v === undefined
    ? fallback
    : v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

function int(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

function flag(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const v = env[name];
  if (v === undefined || v === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(v.toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(v.toLowerCase())) return false;
  throw new Error(`${name} must be true or false`);
}

/**
 * Refuses settings that must never meet: test mode in production (BE-079 criterion 1). Called by
 * `configFromEnv` and by `startService` for a configuration built in code.
 */
export function checkConfig(c: ServiceConfig): void {
  if (c.testMode && c.environment === 'production')
    throw new Error('test mode is refused in production (set DOCEDIT_ENVIRONMENT to test)');
  if (c.webhooks?.testAllow && !c.testMode)
    throw new Error('DOCEDIT_TEST_WEBHOOK_ALLOW is for test mode only (DOCEDIT_TEST_MODE)');
  if (c.s3 && c.azure)
    throw new Error('choose one object store: DOCEDIT_S3_* or DOCEDIT_AZURE_ACCOUNT, not both');
  if (c.assetOrigin && !c.assetUrlKey)
    throw new Error('DOCEDIT_ASSET_ORIGIN needs DOCEDIT_ASSET_URL_KEY');
  if (c.purgeDatabaseUrl && !c.databaseUrl)
    throw new Error('DOCEDIT_PURGE_DATABASE_URL needs DOCEDIT_DATABASE_URL');
  if (c.anchorRetentionDays !== null && c.anchorRetentionDays < 1)
    throw new Error('DOCEDIT_ANCHOR_RETENTION_DAYS is a whole number of days, 1 or more');
  if (c.anchorRetentionDays !== null && !c.sealing)
    throw new Error('DOCEDIT_ANCHOR_RETENTION_DAYS needs the signing service (DOCEDIT_SEAL_URL)');
  if (c.replicaDatabaseUrl && !c.databaseUrl)
    throw new Error('DOCEDIT_REPLICA_DATABASE_URL needs DOCEDIT_DATABASE_URL');
  if (c.replicaDatabaseUrl && c.readSessions === null)
    throw new Error('DOCEDIT_REPLICA_DATABASE_URL needs DOCEDIT_READ_SESSIONS (no default)');
}

/** Settings from DOCEDIT_* variables. Secrets come from the environment, never from a file here. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  // BE-004: the Azure Blob store is selected by its account name; no S3 setting is then needed.
  const azure: AzureBlobSettings | null = env['DOCEDIT_AZURE_ACCOUNT']
    ? {
        endpoint:
          env['DOCEDIT_AZURE_ENDPOINT'] ??
          `https://${env['DOCEDIT_AZURE_ACCOUNT']}.blob.core.windows.net`,
        account: env['DOCEDIT_AZURE_ACCOUNT'],
        accountKey: env['DOCEDIT_AZURE_KEY'] ?? '',
        container: env['DOCEDIT_AZURE_CONTAINER'] ?? 'docedit',
      }
    : null;
  const s3 =
    env['DOCEDIT_S3_ENDPOINT'] || env['DOCEDIT_S3_HOST']
      ? {
          endpoint:
            env['DOCEDIT_S3_ENDPOINT'] ??
            `http://${env['DOCEDIT_S3_HOST']}:${env['DOCEDIT_S3_PORT'] ?? '443'}`,
          region: env['DOCEDIT_S3_REGION'] ?? 'us-east-1',
          bucket: env['DOCEDIT_S3_BUCKET'] ?? 'docedit',
          accessKeyId: env['DOCEDIT_S3_ACCESS_KEY'] ?? '',
          secretAccessKey: env['DOCEDIT_S3_SECRET_KEY'] ?? '',
        }
      : null;
  const signing = env['DOCEDIT_SIGNING_JWK'];
  const cursor = env['DOCEDIT_CURSOR_SECRET'];
  const environment = (env['DOCEDIT_ENVIRONMENT'] ?? DEFAULTS.environment) as Environment;
  if (!['production', 'development', 'test'].includes(environment))
    throw new Error('DOCEDIT_ENVIRONMENT is production, development or test');
  const databaseUrl = env['DOCEDIT_DATABASE_URL'] ?? null;
  const concurrency = env['DOCEDIT_EXPORT_TENANT_CONCURRENCY'];
  const config: ServiceConfig = {
    host: env['DOCEDIT_LISTEN_HOST'] ?? DEFAULTS.host,
    port: int(env, 'DOCEDIT_LISTEN_PORT', DEFAULTS.port),
    publicUrl: env['DOCEDIT_PUBLIC_URL'] ?? null,
    serviceId: env['DOCEDIT_SERVICE_ID'] ?? null,
    databaseUrl,
    s3,
    azure,
    signingJwk: signing ? (JSON.parse(signing) as Record<string, unknown>) : null,
    tenantsFile: env['DOCEDIT_TENANTS_FILE'] ?? null,
    features: env['DOCEDIT_FEATURES'] === undefined ? null : list(env['DOCEDIT_FEATURES'], []),
    maxRebaseSteps:
      env['DOCEDIT_MAX_REBASE_STEPS'] === undefined
        ? null
        : int(env, 'DOCEDIT_MAX_REBASE_STEPS', 1),
    viewKey: env['DOCEDIT_VIEW_KEY'] ? Buffer.from(env['DOCEDIT_VIEW_KEY'], 'base64') : null,
    exportTargets: list(env['DOCEDIT_EXPORT_TARGETS'], DEFAULTS.exportTargets),
    node: env['DOCEDIT_NODE_ID'] ?? `${hostname()}-${process.pid}`,
    nodeAddress: env['DOCEDIT_NODE_ADDRESS'] ?? null,
    nodeRegion: env['DOCEDIT_NODE_REGION'] || null,
    dedicatedDocument: env['DOCEDIT_DEDICATED_DOCUMENT'] || null,
    workers: Math.max(1, int(env, 'DOCEDIT_WORKERS', DEFAULTS.workers)),
    workerTimeoutMs: int(env, 'DOCEDIT_WORKER_TIMEOUT_MS', DEFAULTS.workerTimeoutMs),
    maxBodyBytes: int(env, 'DOCEDIT_MAX_BODY_BYTES', DEFAULTS.maxBodyBytes),
    maxContentBodyBytes: int(env, 'DOCEDIT_MAX_CONTENT_BYTES', DEFAULTS.maxContentBodyBytes),
    signedUrlSeconds: int(env, 'DOCEDIT_SIGNED_URL_SECONDS', DEFAULTS.signedUrlSeconds),
    cursorSecret: cursor ? Buffer.from(cursor, 'utf8') : null,
    rebuiltEntries: int(env, 'DOCEDIT_CONTENT_CACHE', DEFAULTS.rebuiltEntries),
    responseEntries: int(env, 'DOCEDIT_RESPONSE_CACHE', DEFAULTS.responseEntries),
    jobLeaseMs: int(env, 'DOCEDIT_JOB_LEASE_MS', DEFAULTS.jobLeaseMs),
    jobIdleMs: int(env, 'DOCEDIT_JOB_IDLE_MS', DEFAULTS.jobIdleMs),
    jobRetryAfterMs: int(env, 'DOCEDIT_JOB_RETRY_MS', DEFAULTS.jobRetryAfterMs),
    environment,
    testMode: flag(env, 'DOCEDIT_TEST_MODE', DEFAULTS.testMode),
    idempotencyTtlMs: int(env, 'DOCEDIT_IDEMPOTENCY_TTL_MS', DEFAULTS.idempotencyTtlMs),
    idempotencyWaitMs: int(env, 'DOCEDIT_IDEMPOTENCY_WAIT_MS', DEFAULTS.idempotencyWaitMs),
    unavailableRetryAfterS: int(env, 'DOCEDIT_RETRY_AFTER_S', DEFAULTS.unavailableRetryAfterS),
    metricsToken: env['DOCEDIT_METRICS_TOKEN'] || null,
    valkeyUrl: env['DOCEDIT_VALKEY_URL'] || null,
    replicaDatabaseUrl: env['DOCEDIT_REPLICA_DATABASE_URL'] || null,
    purgeDatabaseUrl: env['DOCEDIT_PURGE_DATABASE_URL'] || null,
    readSessions: env['DOCEDIT_READ_SESSIONS'] ? int(env, 'DOCEDIT_READ_SESSIONS', 1) : null,
    readLagDocuments: env['DOCEDIT_READ_LAG_DOCUMENTS']
      ? int(env, 'DOCEDIT_READ_LAG_DOCUMENTS', 1)
      : null,
    fontsDir: env['DOCEDIT_FONTS_DIR'] || null,
    fontsBaseUrl: env['DOCEDIT_FONTS_BASE_URL'] || null,
    assetOrigin: env['DOCEDIT_ASSET_ORIGIN'] || null,
    assetUrlKey: env['DOCEDIT_ASSET_URL_KEY'] || null,
    uploadSeconds: int(env, 'DOCEDIT_UPLOAD_SECONDS', DEFAULTS.uploadSeconds),
    purgeAfterDays: int(env, 'DOCEDIT_PURGE_AFTER_DAYS', DEFAULTS.purgeAfterDays),
    coldAfterDays: int(env, 'DOCEDIT_COLD_AFTER_DAYS', DEFAULTS.coldAfterDays),
    anchorRetentionDays: env['DOCEDIT_ANCHOR_RETENTION_DAYS']
      ? int(env, 'DOCEDIT_ANCHOR_RETENTION_DAYS', 0)
      : null,
    assetWorker: flag(env, 'DOCEDIT_ASSET_WORKER', DEFAULTS.assetWorker),
    previewWindowMs: int(env, 'DOCEDIT_PREVIEW_WINDOW_MS', DEFAULTS.previewWindowMs),
    exportCacheMaxAgeMs: int(env, 'DOCEDIT_EXPORT_CACHE_MS', DEFAULTS.exportCacheMaxAgeMs),
    exportClassVersion: env['DOCEDIT_EXPORT_CLASS_VERSION'] || DEFAULTS.exportClassVersion,
    exportProofKey: env['DOCEDIT_EXPORT_PROOF_KEY'] || null,
    exportTenantConcurrency:
      concurrency === undefined || concurrency === ''
        ? null
        : int(env, 'DOCEDIT_EXPORT_TENANT_CONCURRENCY', 0),
    externalWorkers: flag(env, 'DOCEDIT_EXTERNAL_WORKERS', databaseUrl !== null),
    outboxWaitMs: int(env, 'DOCEDIT_OUTBOX_WAIT_MS', DEFAULTS.outboxWaitMs),
    scheduler: flag(env, 'DOCEDIT_SCHEDULER', DEFAULTS.scheduler),
    searchIndex: flag(env, 'DOCEDIT_SEARCH_INDEX', DEFAULTS.searchIndex),
    webhooks: webhookSettings(env),
    sealing: sealingSettings(env),
  };
  checkConfig(config);
  return config;
}
