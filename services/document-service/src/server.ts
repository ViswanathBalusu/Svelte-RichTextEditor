/**
 * The document service as one process (06 §1 stage 1; BE-001): one HTTP server that serves the
 * control plane (REST, discovery, the JWKS of minted tokens, the probes, the font files, the
 * metrics) and hands WebSocket upgrades on the `ws` path to the data plane, which hosts the rooms.
 * Stage 1 has no bus and no forwarding: every channel of a document reaches the one room this
 * process holds for it. Replays run in worker threads; jobs run in runners of their own kinds (the
 * scheduler's maintenance, the asset worker, the compile worker's exports and previews).
 *
 * Storage is PostgreSQL (service role; migrations run separately as the admin role, BE-011) and an
 * S3-compatible store, or both in memory for development and tests.
 */
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  podmanSandbox,
  signExportUrl,
  type AssetUrlKeys,
  type Sandbox,
} from '@docedit/asset-worker';
import { createDataPlane as defaultDataPlane } from './data-plane/index.ts';
import { planeOf } from './data-plane/restartable.ts';
import { RegistryAssetAttachments } from './data-plane/asset-attachments.ts';
import { RateLimits } from './data-plane/limits.ts';
import { AnnouncingNotifier, listenForAnnouncements } from './data-plane/announcements.ts';
import type { Bus } from './data-plane/bus.ts';
import { ValkeyBus } from './data-plane/valkey-bus.ts';
import { ValkeyTokenBuckets } from './data-plane/valkey-buckets.ts';
import { DEFAULT_FEATURES, DEFAULT_RATES } from './data-plane/settings.ts';
import {
  MemoryAudit,
  MemoryCheckpointIndex,
  MemoryNodeLeases,
  MemoryOutbox,
} from './data-plane/memory-ports.ts';
import { PgAuditStore } from './data-plane/pg/audit.ts';
import { PgCheckpointIndex } from './data-plane/pg/checkpoint-index.ts';
import { PgNodeLeases } from './data-plane/pg/leases.ts';
import { PgOutbox } from './data-plane/pg/outbox.ts';
import { keyedViewToken } from './data-plane/view.ts';
import { checkConfig, type ServiceConfig } from './config.ts';
import {
  MemoryAssetRegistry,
  PgAssetRegistry,
  type AssetRegistry,
} from './control-plane/assets.ts';
import { ContentReader } from './control-plane/content.ts';
import { Placement } from './control-plane/room-routing.ts';
import { MemoryEventSink, type EventSink } from './control-plane/events.ts';
import { DebouncedEventSink } from './control-plane/event-throttle.ts';
import { CompileBudget } from './control-plane/exp-009-compile-budget.ts';
import { EXPORT_KIND, PREVIEW_KIND, exportHooks } from './control-plane/exports.ts';
import {
  IMPORT_KIND,
  importHooks,
  importJobHandler,
  type DocxImporter,
} from './control-plane/imports.ts';
import {
  LIVE_QUOTA_COUNT_RETRY_MS,
  LIVE_QUOTA_WINDOW_MS,
  LiveQuotas,
  type QuotaSource,
} from './control-plane/live-quotas.ts';
import {
  emptyCatalogue,
  fontFileHandler,
  loadFontCatalogue,
  type FontCatalogue,
} from './control-plane/fonts.ts';
import { createHandlers } from './control-plane/handlers.ts';
import type { HandlerDeps } from './control-plane/kit.ts';
import { BULK_SEND_KIND, bulkSendHandler } from './control-plane/bulk-send.ts';
import type {
  SubscriptionStore,
  WebhookSubscriptions,
} from './control-plane/webhook-subscriptions.ts';
import { composeWebhooks, type WebhookOverrides } from './control-plane/webhook-composition.ts';
import type { WebhookDispatcher } from './control-plane/webhook-dispatcher.ts';
import { abandonedUploadsTask } from './control-plane/asset-sweep.ts';
import {
  MemoryRetentionStore,
  RetentionService,
  type RetentionStore,
} from './control-plane/retention.ts';
import { PgRetentionStore } from './control-plane/retention-pg.ts';
import {
  HistoryVisibilityService,
  MemoryVisibilityStore,
  withEffectiveHistoryVisibility,
  type VisibilityStore,
} from './control-plane/history-visibility.ts';
import { PgVisibilityStore } from './control-plane/history-visibility-pg.ts';
import { QuotaAdminService, type QuotaAdminStore } from './control-plane/quota-admin.ts';
import { MemoryQuotaStore } from './control-plane/quotas.ts';
import { PgQuotaStore } from './control-plane/quotas-pg.ts';
import { HoldService, MemoryHoldStore, type HoldStore } from './control-plane/holds.ts';
import { ErasureRequests } from './control-plane/erasure-requests.ts';
import { CommitTombstone, type TombstoneStore } from './control-plane/commit-tombstone.ts';
import {
  DAY_MS,
  DocumentPurge,
  type PurgeStore,
  type SearchPurge,
} from './control-plane/document-purge.ts';
import { PgPurgeStore } from './control-plane/document-purge-pg.ts';
import { PgHoldStore } from './control-plane/holds-pg.ts';
import {
  MemoryWorkflowResourceStore,
  type WorkflowResourceStore,
} from './workflow/workflow-resource.ts';
import { PgWorkflowResourceStore } from './workflow/workflow-resource-pg.ts';
import { MemoryTemplateStore, type TemplateStore } from './workflow/template-store.ts';
import { PgTemplateStore } from './workflow/template-store-pg.ts';
import { MemoryReminderStore, type ReminderStore } from './workflow/reminder-store.ts';
import { PgReminderStore } from './workflow/reminder-store-pg.ts';
import { MemoryEvidenceLedger, type EvidenceLedger } from './workflow/evidence-ledger.ts';
import { PgEvidenceLedger } from './workflow/evidence-ledger-pg.ts';
import { MemorySealedPdfStore, type SealedPdfStore } from './workflow/sealed-store.ts';
import { MemoryAccessCodeStore, type AccessCodeStore } from './workflow/access-code-store.ts';
import { PgAccessCodeStore } from './workflow/access-code-pg.ts';
import type { ConsentTextStore } from './workflow/consent-service.ts';
import { sweepTenant } from './workflow/schedule-sweep.ts';
import { FinalSealer } from './workflow/final-seal.ts';
import { appearanceRequestFor } from './workflow/appearances.ts';
import { MemoryAnchorStore, type AnchorStore } from './workflow/anchor-store.ts';
import { HttpSigningClient, type SigningClient } from './workflow/signing-client.ts';
import { recordParticipantOpened } from './workflow/participant-view.ts';
import type { PolicyHookGate } from './control-plane/policy-hook-client.ts';
import type { SearchService } from './control-plane/search-routes.ts';
import { SearchIndex } from './control-plane/search-index.ts';
import { PgSearchIndex } from './control-plane/search-index-pg.ts';
import {
  createSearchIndexHandler,
  enqueueIndexing,
  SEARCH_INDEX_KIND,
  type IndexTarget,
} from './control-plane/search-indexer.ts';
import { Workers } from './data-plane/workers.ts';
import { Cursors } from './control-plane/http.ts';
import {
  MemoryIdempotencyStore,
  PgIdempotencyStore,
  type IdempotencyStore,
} from './control-plane/idempotency.ts';
import { PgJobQueue } from './control-plane/jobs/pg.ts';
import { MemoryJobQueue, type JobQueue, type JobRecord } from './control-plane/jobs/queue.ts';
import { JobRunner, type JobHandler, type JobHooks } from './control-plane/jobs/runner.ts';
import {
  DRIVERS,
  Metrics,
  TenantMeter,
  meteredCheckpoints,
  meteredLogs,
} from './control-plane/metrics.ts';
import { Pipeline, type PlainHandler, type Reply } from './control-plane/pipeline.ts';
import { auditPartitionsTask } from './control-plane/audit-partitions-task.ts';
import {
  CheckpointThinning,
  checkpointThinningTask,
  type CheckpointThinningStore,
} from './control-plane/checkpoint-thinning.ts';
import { gateThinning } from './data-plane/recovery.ts';
import {
  PayloadThinning,
  payloadThinningTask,
  type ThinningStore,
} from './control-plane/payload-thinning.ts';
import { SCHEDULE_KIND, Scheduler, type ScheduledTask } from './control-plane/scheduler.ts';
import { applySeed, parseSeed } from './control-plane/seed.ts';
import {
  MemoryTenantRegistry,
  PgTenantRegistry,
  type TenantRegistry,
} from './control-plane/tenants.ts';
import { registerProcessMetrics } from './control-plane/process-metrics.ts';
import { TEST_TIMERS, testHooks, type TestTimers } from './control-plane/test-hooks.ts';
import { signingKey, TokenService, type SigningKey } from './control-plane/tokens.ts';
import { MemoryUserDirectory, PgUserDirectory, type UserDirectory } from './control-plane/users.ts';
import { restrictedViews, type Views } from './control-plane/visibility.ts';
import { serialisedInPool } from './control-plane/workers/checkpoint-store.ts';
import { WorkerPool } from './control-plane/workers/pool.ts';
import {
  Autoscaler,
  WorkerPool as JobWorkerPool,
  type ScalePolicy,
} from './control-plane/jobs/autoscale.ts';
import { PinnedCache } from './control-plane/pinned-cache.ts';
import {
  headSeq,
  ReadRouter,
  ReadSessions,
  type ReadStores,
} from './control-plane/read-routing.ts';
import { errorFields, SILENT, type Logger } from './log.ts';
import {
  ASSET_JOB_KIND,
  assetJobHandler,
  assetUploads,
  workerObjects,
} from './objects/asset-pipeline.ts';
import {
  ObjectAssetStore,
  encodeCheckpoint,
  ObjectCheckpointStore,
} from './objects/checkpoints.ts';
import { DocumentKeyedObjectStore, sealExistingObjects } from './objects/document-keyed-store.ts';
import { DocumentKeys, type DocumentKeyStore } from './storage/document-keys.ts';
import type { KeyService } from './storage/key-service.ts';
import { S3ObjectStore } from './objects/s3.ts';
import { AzureBlobObjectStore } from './objects/azure.ts';
import { MemoryObjectStore, type ObjectStore } from './objects/store.ts';
import type { CreateDataPlane, DataPlane, ErrorContext, ParticipantOpened, Span } from './seams.ts';
import { createPool, inTenant, isUuid, sqlState, type Pool } from './storage/db.ts';
import { PgDocumentStore } from './storage/document-store.ts';
import { PgGrantStore } from './storage/grant-store.ts';
import { PgLogStore } from './storage/log-store.ts';
import { MemoryStore } from './storage/memory.ts';
import { MemoryHomeRegions, PgHomeRegions } from './storage/home-regions.ts';
import { appliedMigrations, compatibility, loadMigrations } from './storage/migrate.ts';
import {
  MemoryReadMarkerStore,
  PgReadMarkerStore,
  type ReadMarkerStore,
} from './storage/read-markers.ts';
import { MemoryThreadStore, PgThreadStore, type ThreadStore } from './storage/thread-store.ts';
import { PgVersionStore } from './storage/versions-store.ts';
import { MemoryVersionStore, type VersionStorePort } from './storage/versions-memory.ts';
import { Tracer } from './data-plane/tracing.ts';
import type {
  AssetStore,
  AuditStore,
  CheckpointIndex,
  CheckpointStore,
  DocRef,
  DocumentStore,
  GrantStore,
  HomeRegionStore,
  LogStore,
  NodeLeaseStore,
  OutboxStore,
  OwnershipStore,
} from './storage/types.ts';

/** The parts a service is built from; tests replace any of them. */
export interface ServiceParts {
  logs: LogStore;
  ownership: OwnershipStore;
  grants: GrantStore;
  documents: DocumentStore;
  objects: ObjectStore;
  registry: TenantRegistry;
  users: UserDirectory;
  queue: JobQueue;
  /** Set when the parts run on PostgreSQL: the readiness probe and `close()` use it. */
  pool: Pool | null;
  /**
   * The readiness probe, for parts that span several databases (sharded PostgreSQL, BE-070). It
   * replaces the probe over `pool`, which looks at one database only. Absent: `pool` is probed.
   */
  readiness?: () => Promise<Readiness>;
  /** The home regions of tenants and documents (BE-074). Absent: no tenant has a home region. */
  homeRegions?: HomeRegionStore;
  // --- Phase 1b. --------------------------------------------------------------------------------
  idempotency: IdempotencyStore;
  assetRegistry: AssetRegistry;
  /** Ports of the data plane's phase 1b (packet A); each is optional to it. */
  checkpointIndex?: CheckpointIndex;
  audit?: AuditStore;
  /** The webhook subscriptions of `/webhooks` (UX-079). Absent: the routes are not offered. */
  webhooks?: WebhookSubscriptions;
  /**
   * The store under `webhooks`, shared with the dispatcher when `config.webhooks` is set (PRM-053).
   * Absent: an in-memory store, and `webhooks` is built over it.
   */
  webhookStore?: SubscriptionStore;
  /** The retention policies of `/retention` (UX-080). Absent: the routes are not offered. */
  retention?: RetentionService;
  /** The history visibility settings of /history-visibility (HIS-025). Absent: not offered. */
  historyVisibility?: HistoryVisibilityService;
  /** The legal holds of `/holds` and `/documents/{id}/holds` (UX-080). Absent: the routes are not offered. */
  holds?: HoldService;
  /**
   * The rows of the purge of deleted documents (HIS-039). Needs a pool that connects as a member of
   * docedit_purge (migration 0073), so `pgParts` does not make it. Absent: no purge task runs.
   */
  purgeStore?: PurgeStore;
  /** The search entries the purge removes with a document (HIS-039). Optional. */
  searchPurge?: SearchPurge;
  /**
   * The rows of a commit tombstone (HIS-040). Like `purgeStore` it needs a pool that connects as a
   * member of `docedit_purge`. Absent: the route is not offered.
   */
  tombstoneStore?: TombstoneStore;
  /**
   * The rows of the thinning of old payloads (HIS-032). Like `purgeStore` it needs a pool that
   * connects as a member of `docedit_purge`. Absent: no thinning task runs.
   */
  thinningStore?: ThinningStore;
  /**
   * The rows of the thinning of old checkpoints (HIS-030). Like `purgeStore` it needs a pool that
   * connects as a member of `docedit_purge`. Absent: no checkpoint thinning task runs.
   */
  checkpointThinningStore?: CheckpointThinningStore;
  /**
   * Per-document keys (HIS-041). With both `documentKeyStore` and `keyService`, the service seals
   * the payloads and objects of documents that have a key and builds `documentKeys` to give and
   * destroy keys (`PgDocumentKeyStore` is the store of the PostgreSQL composition). Absent: no
   * document has a key and nothing is sealed.
   */
  documentKeyStore?: DocumentKeyStore;
  keyService?: KeyService;
  /** Built by `startService` from the two parts above. */
  documentKeys?: DocumentKeys;
  /** The workflow resource of `/documents/{id}/workflow` (FRW-025). Absent: the routes and the feature `workflow` are not offered. */
  workflows?: WorkflowResourceStore;
  /** The templates of /templates (FRW-062). Absent: the routes are not offered. */
  templates?: TemplateStore;
  /** The count of scheduled reminders raised per participant (FRW-034). Absent: none are raised. */
  reminders?: ReminderStore;
  /** The workflow evidence ledger (FRW-041): evidence in its own workflow table, hashes for the chain. */
  evidence?: EvidenceLedger;
  /** The sealed final PDFs (FRW-054): `GET /documents/{id}/workflow/final` reads them. Absent: the route is not offered. */
  sealedPdfs?: SealedPdfStore;
  /** The signed, time-stamped chain heads at completion, written once (FRW-054 criterion 3). */
  anchors?: AnchorStore;
  /** The registered access codes of workflow participants and their attempt counters (FRW-039). */
  accessCodes?: AccessCodeStore;
  /** The consent texts of the tenants (FRW-044). Absent: the consent route is not offered. */
  consentTexts?: ConsentTextStore;
  /** The tenant quota values of `/quotas` (UX-078 criterion 1). Absent: the routes are not offered. */
  quotaAdmin?: QuotaAdminService;
  /** The tenant's data-loss prevention hook, asked before an export (UX-086). Absent: none is asked. */
  policyHook?: PolicyHookGate;
  /** The index `GET /search` queries (UX-084). Absent: the route is not offered. */
  search?: SearchService;
  outbox?: OutboxStore;
  leases?: NodeLeaseStore;
  /** The read markers of `/read-marker` (HIS-027). Absent: the route is not offered. */
  readMarkers?: ReadMarkerStore;
  /** The comment threads of `/threads` (PRO-059, PRO-060). Absent: the routes are not offered. */
  threads?: ThreadStore;
  /** The named versions of `/versions` (HIS-006; PRO-054). Absent: the routes are not offered. */
  versions?: VersionStorePort;
  // --- Scaling (BE-064). ------------------------------------------------------------------------
  /**
   * A read replica of the database for the read-only routes: lists and pinned content. Absent:
   * every read goes to the primary. Its log tells how far it has applied each document.
   */
  replica?: {
    logs: LogStore;
    documents: DocumentStore;
    grants: GrantStore;
    /** The version rows, for history reads on the replica (BE-064). */
    versions?: VersionStorePort;
  };
  /** The tenants' quota values; the `exportMinutes` budget is read at each export (EXP-009). */
  quotas?: QuotaSource;
}

export interface StartOptions {
  config: ServiceConfig;
  parts?: Partial<ServiceParts>;
  createDataPlane?: CreateDataPlane;
  /**
   * The node's shared rate limits (BE-030): the data plane's socket buckets and the REST pipeline
   * draw from the same instance. Absent: the default settings (`DEFAULT_RATES`).
   */
  rateLimits?: RateLimits;
  /**
   * The bus between nodes (BE-062, BE-063). Absent: with `DOCEDIT_VALKEY_URL` and node leases the
   * service opens its own Valkey streams bus; otherwise there is none and the node is alone.
   */
  bus?: Bus;
  logger?: Logger;
  /** The event sink of both planes. Not with `config.webhooks`, whose dispatcher is the sink. */
  events?: EventSink;
  /** With `config.webhooks`: a recording transport or a delivery store a test reads (PRM-053). */
  webhooks?: WebhookOverrides;
  /** Finished request spans (PRO-044 criterion 1); absent: none recorded. */
  onSpan?: (span: Span) => void;
  /**
   * Job handlers run in this process, by kind: the compile worker's `export` (which also takes
   * `preview` when no handler of its own is given) and anything else. None: no export runner.
   */
  jobHandlers?: Readonly<Record<string, JobHandler>>;
  /**
   * Reads a `.docx` file into CDM content (EXP-098). With it, this node offers `/imports` and runs
   * the import job in process; without it, the routes are `not_found`. The package of the importer
   * is not a dependency of this service, so a host passes it in.
   */
  importer?: DocxImporter;
  /**
   * The asset worker in this process (PRO-061): its sandbox, or `unsandboxed()` with
   * `allowUnsandboxed` in tests. Default: `podmanSandbox()` when `config.assetWorker` is set.
   */
  assetWorker?: { sandbox: Sandbox; allowUnsandboxed?: boolean } | null;
  /** The font set; default from `config.fontsDir`. */
  fonts?: FontCatalogue;
  /** Read restrictions (ADR 0019, proposed): absent, every reader is in the full class. */
  views?: Views;
  signing?: SigningKey;
  now?: () => number;
  /** For the tests of BE-001 criterion 4 only. */
  allowWorkerCrash?: boolean;
  /**
   * Export workers that follow the queue (BE-065): the floor, the ceiling and the backlog per
   * worker, and how often the queue depth is read, ms. Absent: one export runner. Settings with
   * no default, because the spec gives no measured numbers.
   */
  exportScaling?: { policy: ScalePolicy; tickMs: number };
  /**
   * The seal step of finalisation (FRW-052 criterion 5, FRW-053): the signing service's client, the
   * retry of a run, how long the sealed bytes are retained, and the wait between attempts. Default:
   * built from `config.sealing` (`DOCEDIT_SEAL_*`); with neither, nothing is sealed and a completed
   * workflow stays `completed`. It needs `parts.workflows` and `parts.sealedPdfs`.
   */
  finalSealing?: {
    signing: SigningClient;
    retry: { attempts: number; delaysMs: readonly number[] };
    retainMs: number;
    sleep?: (ms: number) => Promise<void>;
  };
  /** Read-your-writes sessions kept at most, with `parts.replica` (BE-064 criterion 3; a setting). */
  readSessions?: number;
  /**
   * Documents whose replica lag is sampled again at each metrics scrape (BE-064 criterion 4; a
   * setting, with `parts.replica`). Absent: no lag is sampled at a scrape.
   */
  readLagDocuments?: number;
  /**
   * Version-pinned content cached in this process (BE-075): whether a tenant allows it, and the
   * copies held at most (a setting). Absent: nothing is cached.
   */
  pinnedCache?: { enabled(tenant: string): boolean; maxEntries: number };
}

export interface Readiness {
  ready: boolean;
  /** Why not; identifiers and versions only. */
  reason?: string;
  schema?: string | null;
  expected?: string;
}

export interface Service {
  /** The base URL the server listens on, for example `http://127.0.0.1:53211`. */
  url: string;
  server: Server;
  parts: ServiceParts;
  checkpoints: CheckpointStore;
  assets: AssetStore;
  tokens: TokenService;
  dataPlane: DataPlane;
  content: ContentReader;
  pool: WorkerPool;
  events: EventSink;
  /** The webhook dispatcher when `config.webhooks` is set (PRM-053), or null. It is `events`. */
  webhooks: WebhookDispatcher | null;
  /** The worker threads that count the words of a checkpoint (BE-054), or null when search is off. */
  searchWorkers: Workers | null;
  /** The runner of the in-process export handlers, or null. */
  runner: JobRunner | null;
  /** Every runner of the process: maintenance, assets, exports. */
  runners: JobRunner[];
  /** The seal step of finalisation (FRW-053), or null when this node does not seal. */
  sealer: FinalSealer | null;
  scheduler: Scheduler | null;
  metrics: Metrics;
  meter: TenantMeter;
  fonts: FontCatalogue;
  /** The autoscaled export workers and their scaler (BE-065), or null. */
  exportWorkers: JobWorkerPool | null;
  autoscaler: Autoscaler | null;
  /** The router of read-only routes when a replica is configured (BE-064), or null. */
  reads: ReadRouter<ReadStores> | null;
  /** The cache of version-pinned content (BE-075), or null. */
  pinnedCache: PinnedCache | null;
  ready(): Promise<Readiness>;
  close(): Promise<void>;
}

export const REST_PATH = '/v1';
export const WS_PATH = '/dep';

/**
 * The features a service announces: the list it was given, and `test-hooks` while its test-mode
 * switch is on (05 §2, §11; ADR 0219, ADR 0398). The configuration refuses test mode in production,
 * so a production service never announces it.
 */
function withTestHooks(
  config: { testMode: boolean },
  features: readonly string[],
): readonly string[] {
  return config.testMode && !features.includes('test-hooks')
    ? [...features, 'test-hooks']
    : features;
}

/**
 * The retention policies of `/retention` (UX-080) over a policy store, the parts' document store
 * and audit trail. A document is known when it exists in the tenant and is not deleted; an
 * identifier that is not a UUID names no document. A caller that replaces `documents` or `audit`
 * in the parts should replace `retention` too: this one keeps the stores it was built over.
 */
function retentionOver(
  store: RetentionStore,
  documents: DocumentStore,
  audit: AuditStore,
  now: () => number,
): RetentionService {
  return new RetentionService({
    store,
    audit,
    documentExists: async (tenant, doc) => {
      if (!isUuid(doc)) return false;
      const record = await documents.get({ tenant, doc });
      return record !== null && record.deletedAt === null;
    },
    now,
  });
}

/**
 * The history visibility settings of `/history-visibility` (HIS-025) over a settings store, the
 * document store and the audit trail. The document store given to the gate and the rooms is wrapped
 * by withEffectiveHistoryVisibility over the same settings store, so that a change applies to the
 * next request.
 */
function visibilityOver(
  store: VisibilityStore,
  documents: DocumentStore,
  audit: AuditStore,
  now: () => number,
): HistoryVisibilityService {
  return new HistoryVisibilityService({
    store,
    audit,
    documentExists: async (tenant, doc) => {
      if (!isUuid(doc)) return false;
      const record = await documents.get({ tenant, doc });
      return record !== null && record.deletedAt === null;
    },
    now,
  });
}

/**
 * The legal holds of `/holds` (UX-080 criteria 2 and 3) over a hold store, the parts' document
 * store and audit trail. The same rule as `retentionOver` applies to the stores it keeps.
 */
function holdsOver(
  store: HoldStore,
  documents: DocumentStore,
  audit: AuditStore,
  now: () => number,
): HoldService {
  return new HoldService({
    store,
    audit,
    documentExists: async (tenant, doc) => {
      if (!isUuid(doc)) return false;
      const record = await documents.get({ tenant, doc });
      return record !== null && record.deletedAt === null;
    },
    now,
  });
}

/**
 * The erasure of a person (HIS-038): over the parts' user directory and audit trail. A person is only
 * deferred by a hold on a document they wrote in, so the documents asked about are the held ones.
 * The pending requests live in memory (erasure-requests.ts).
 */
function erasuresOver(parts: ServiceParts, now: () => number): ErasureRequests | undefined {
  const { audit, holds, logs } = parts;
  if (!audit) return undefined;
  return new ErasureRequests({
    users: parts.users,
    audit,
    heldDocuments: async (tenant) => (holds ? holds.heldDocuments(tenant) : new Set<string>()),
    documentsOf: async (tenant, surrogate) => {
      const wrote: string[] = [];
      for (const doc of holds ? await holds.heldDocuments(tenant) : [])
        if ((await logs.read({ tenant, doc })).some((c) => c.user === surrogate)) wrote.push(doc);
      return wrote;
    },
    now,
  });
}

/**
 * The tenant quota values of `/quotas` (UX-078) over a quota store and the parts' audit trail. The
 * store refuses a tenant it does not know (PostgreSQL asks the `tenants` table).
 */
function quotaAdminOver(
  store: QuotaAdminStore,
  audit: AuditStore,
  now: () => number,
): QuotaAdminService {
  return new QuotaAdminService({ store, audit, now });
}

/** The registry of a data plane that has one (the shipped one does; a test double may not). */
interface DataPlaneRegistry {
  metricsRegistry?: { checkpointMismatches: { inc(labels: Record<string, string>): void } };
}

/** Parts over PostgreSQL with the service role (06 §4.1; BE-011). */
export function pgParts(pool: Pool, now: () => number = Date.now): ServiceParts {
  const grants = new PgGrantStore(pool);
  const logs = new PgLogStore(pool, { permissions: (ref) => grants.current(ref) });
  const documents = new PgDocumentStore(pool);
  const visibility = new PgVisibilityStore(pool);
  const audit = new PgAuditStore(pool);
  return {
    logs,
    ownership: logs,
    grants,
    documents: withEffectiveHistoryVisibility(documents, visibility),
    objects: new MemoryObjectStore(),
    registry: new PgTenantRegistry(pool),
    users: new PgUserDirectory(pool),
    queue: new PgJobQueue(pool),
    pool,
    idempotency: new PgIdempotencyStore(pool),
    assetRegistry: new PgAssetRegistry(pool),
    checkpointIndex: new PgCheckpointIndex(pool),
    audit,
    retention: retentionOver(new PgRetentionStore(pool), documents, audit, now),
    historyVisibility: visibilityOver(visibility, documents, audit, now),
    holds: holdsOver(new PgHoldStore(pool), documents, audit, now),
    workflows: new PgWorkflowResourceStore(pool, { now }),
    templates: new PgTemplateStore(pool),
    reminders: new PgReminderStore(pool),
    evidence: new PgEvidenceLedger(pool, { now }),
    accessCodes: new PgAccessCodeStore(pool),
    quotaAdmin: quotaAdminOver(
      new PgQuotaStore(pool, (tenant) =>
        // `tenants` is under row-level security, so the question runs in the tenant's own context.
        inTenant(
          pool,
          tenant,
          async (c) =>
            ((await c.query('select 1 from tenants where id::text = $1', [tenant])).rowCount ?? 0) >
            0,
          { readOnly: true },
        ),
      ),
      audit,
      now,
    ),
    outbox: new PgOutbox(pool),
    leases: new PgNodeLeases(pool),
    homeRegions: new PgHomeRegions(pool),
    readMarkers: new PgReadMarkerStore(pool),
    threads: new PgThreadStore(pool),
    versions: new PgVersionStore(pool),
  };
}

/** Parts in memory: nothing outlives the process. */
export function memoryParts(now: () => number = Date.now): ServiceParts {
  const store = new MemoryStore();
  const audit = new MemoryAudit();
  const visibility = new MemoryVisibilityStore();
  return {
    logs: store,
    ownership: store,
    grants: store,
    documents: withEffectiveHistoryVisibility(store, visibility),
    objects: new MemoryObjectStore(),
    registry: new MemoryTenantRegistry(now),
    users: new MemoryUserDirectory(),
    queue: new MemoryJobQueue(now),
    pool: null,
    idempotency: new MemoryIdempotencyStore(),
    assetRegistry: new MemoryAssetRegistry(),
    checkpointIndex: new MemoryCheckpointIndex(now),
    audit,
    retention: retentionOver(new MemoryRetentionStore(), store, audit, now),
    historyVisibility: visibilityOver(visibility, store, audit, now),
    holds: holdsOver(new MemoryHoldStore(), store, audit, now),
    workflows: new MemoryWorkflowResourceStore(),
    templates: new MemoryTemplateStore(),
    reminders: new MemoryReminderStore(),
    evidence: new MemoryEvidenceLedger(now),
    sealedPdfs: new MemorySealedPdfStore(),
    anchors: new MemoryAnchorStore(),
    accessCodes: new MemoryAccessCodeStore(),
    quotaAdmin: quotaAdminOver(
      // The pipeline has authenticated the tenant before a quota route runs, so every tenant that
      // reaches it is registered; the memory store has no other tenant table to ask.
      new MemoryQuotaStore(() => true),
      audit,
      now,
    ),
    outbox: new MemoryOutbox(now),
    leases: new MemoryNodeLeases(),
    homeRegions: new MemoryHomeRegions(),
    readMarkers: new MemoryReadMarkerStore(),
    threads: new MemoryThreadStore(),
    versions: new MemoryVersionStore((ref) => store.head(ref).then((h) => h.seq)),
  };
}

let knownMigrations: Promise<string[]> | null = null;

/**
 * Readiness (BE-001 criterion 5; BE-016 criterion 1; BE-006 criterion 4): the database answers,
 * every migration this code knows is applied, and every applied one it does not know (a newer
 * release's) is an expand step, so that two releases can run side by side during a rollout and
 * the previous release starts again after a rollback.
 */
export async function readiness(pool: Pool | null): Promise<Readiness> {
  if (!pool) return { ready: true };
  knownMigrations ??= loadMigrations().then((all) => all.map((m) => m.version));
  const known = await knownMigrations;
  const expected = known[known.length - 1]!;
  let applied;
  try {
    applied = await appliedMigrations(pool);
  } catch (e) {
    const state = sqlState(e);
    return {
      ready: false,
      reason: state
        ? `the database refused to give its schema version (SQLSTATE ${state})`
        : `the database is unreachable (${errorFields(e).error})`,
      expected,
    };
  }
  const schema = applied.length ? applied[applied.length - 1]!.version : null;
  const c = compatibility(known, applied);
  if (c.ok) return { ready: true, schema, expected };
  const unknown = c.unknown.find((u) => u.phase !== 'expand');
  return {
    ready: false,
    reason: c.pending.length
      ? `the schema is at ${schema ?? 'no migration'} without ${c.pending[0]}; the code expects ${expected}`
      : `the schema has ${unknown?.version ?? schema}, which the code does not know and is not an expand step; the code expects ${expected}`,
    schema,
    expected,
  };
}

/** `<id>:<base64 secret>` as the asset origin's keys. */
function assetUrlKeys(text: string | null): AssetUrlKeys | null {
  if (!text) return null;
  const i = text.indexOf(':');
  if (i < 1) throw new Error('DOCEDIT_ASSET_URL_KEY is <id>:<base64 secret>');
  return { current: { id: text.slice(0, i), secret: Buffer.from(text.slice(i + 1), 'base64') } };
}

/** The visibility class the search index holds: what a service credential reads (ADR 0019). */
const SEARCH_FULL_CLASS = 'full';
/**
 * The threads that count the words of a checkpoint, and the time one count may take (BE-054
 * criterion 5). Proposed defaults, not measurements: one thread keeps the indexer's use of the
 * machine small, and a count that runs past the limit fails its job, which is retried.
 */
const SEARCH_WORKER_THREADS = 1;
const SEARCH_TASK_TIMEOUT_MS = 30_000;

export async function startService(opts: StartOptions): Promise<Service> {
  const config = opts.config;
  checkConfig(config);
  const now = opts.now ?? Date.now;
  const logger = opts.logger ?? SILENT;
  // Test mode shortens the timers the conformance kit waits on (BE-079 criterion 2).
  const timers: TestTimers | null = config.testMode ? TEST_TIMERS : null;
  const db = config.databaseUrl
    ? createPool({ connectionString: config.databaseUrl, connectionTimeoutMillis: 5000 })
    : null;
  const base = db ? pgParts(db, now) : memoryParts(now);
  // BE-064: with a replica URL the read-only routes can be served from the standby. It is a second
  // pool over the same schema; it is only read from, and what it holds is what the standby applied.
  const replicaDb =
    db && config.replicaDatabaseUrl
      ? createPool({ connectionString: config.replicaDatabaseUrl, connectionTimeoutMillis: 5000 })
      : null;
  if (replicaDb) {
    const replicaGrants = new PgGrantStore(replicaDb);
    base.replica = {
      logs: new PgLogStore(replicaDb, { permissions: (ref) => replicaGrants.current(ref) }),
      documents: withEffectiveHistoryVisibility(
        new PgDocumentStore(replicaDb),
        new PgVisibilityStore(replicaDb),
      ),
      grants: replicaGrants,
      versions: new PgVersionStore(replicaDb),
    };
  }
  // The purge of deleted documents (HIS-039) connects as a member of docedit_purge, a pool of its own.
  const purgeDb =
    db && config.purgeDatabaseUrl
      ? createPool({ connectionString: config.purgeDatabaseUrl, connectionTimeoutMillis: 5000 })
      : null;
  if (purgeDb) base.purgeStore = new PgPurgeStore(purgeDb);
  if (config.s3) base.objects = new S3ObjectStore(config.s3);
  else if (config.azure) base.objects = new AzureBlobObjectStore(config.azure);
  const parts: ServiceParts = { ...base, ...opts.parts };
  if (parts.documentKeyStore && parts.keyService) {
    const rawObjects = parts.objects;
    const keys = new DocumentKeys({
      store: parts.documentKeyStore,
      keys: parts.keyService,
      headSeq: async (ref) => (await parts.logs.head(ref)).seq,
      sealExisting: async (ref, sealer) => {
        await sealExistingObjects(rawObjects, ref, sealer);
      },
      now,
    });
    if (parts.logs instanceof PgLogStore) parts.logs.useDocumentKeys(keys);
    parts.objects = new DocumentKeyedObjectStore(rawObjects, keys);
    parts.documentKeys = keys;
  }
  const erasures = erasuresOver(parts, now);
  // A release lets the erasures that waited for the hold run (HIS-031; owner decision 85).
  if (parts.holds && erasures) {
    const afterErasures = parts.holds.afterRelease;
    parts.holds.afterRelease = async (tenant, doc) => {
      await afterErasures?.(tenant, doc);
      await erasures.afterRelease(tenant);
    };
  }
  const tombstones =
    parts.tombstoneStore && parts.audit && parts.checkpointIndex
      ? new CommitTombstone({
          store: parts.tombstoneStore,
          documents: parts.documents,
          checkpoints: parts.checkpointIndex,
          objects: parts.objects,
          audit: parts.audit,
          held: async (tenant, doc) => (parts.holds ? parts.holds.inForce(tenant, doc) : false),
          now,
        })
      : undefined;
  const readSessionsMax = opts.readSessions ?? config.readSessions ?? undefined;
  const readLagDocuments = opts.readLagDocuments ?? config.readLagDocuments ?? undefined;
  if (parts.replica && readSessionsMax === undefined)
    throw new Error('a read replica needs readSessions, the sessions kept for read-your-writes');
  // The node labels every control-plane series too (06 §11; BE-086 criterion 2).
  const metrics = new Metrics({ node: config.node });
  const meter = new TenantMeter(metrics);
  // Every log write and checkpoint is metered per tenant, the data plane's too (BE-085).
  const logs = meteredLogs(parts.logs, meter);
  const objectCheckpoints = new ObjectCheckpointStore(parts.objects);
  const checkpoints = meteredCheckpoints(objectCheckpoints, meter, encodeCheckpoint);
  const assets = new ObjectAssetStore(parts.objects, (tenant, bytes, kind) =>
    meter.add(tenant, DRIVERS.storedBytes, bytes, { kind }),
  );
  if (config.webhooks && opts.events)
    throw new Error(
      'config.webhooks and events are exclusive: the webhook dispatcher is the event sink',
    );
  // One key for the view tokens of both planes, so that a client resumes a channel with the token
  // of the content it read over REST (ADR 0019 change 1; G101; D70).
  const viewKey = config.viewKey ?? randomBytes(32);
  // Read restrictions are on by default (ADR 0019): a reader without access gets the projection.
  const views: Views = opts.views ?? restrictedViews(now, (h) => keyedViewToken(viewKey, h));

  if (config.tenantsFile) {
    const seed = parseSeed(JSON.parse(await readFile(config.tenantsFile, 'utf8')));
    // One bad entry is reported and skipped; the rest of the file applies (ADR 0054).
    for (const s of await applySeed(parts.registry, seed))
      logger.warn({ event: 'tenants.skipped', message: `${s.path}: ${s.reason}` });
  }

  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => resolve());
  });
  const address = server.address() as AddressInfo;
  const listening = `http://${address.family === 'IPv6' ? `[${address.address}]` : address.address}:${address.port}`;
  const publicUrl = (config.publicUrl ?? listening).replace(/\/$/, '');
  const serviceId = config.serviceId ?? publicUrl;

  // Webhook delivery (PRM-053; BE-055, BE-056): the dispatcher is the event sink of both planes,
  // and the `/webhooks` routes share its subscription store.
  const webhooks = config.webhooks
    ? composeWebhooks({
        settings: config.webhooks,
        serviceId,
        now,
        logger,
        ...(parts.webhookStore ? { store: parts.webhookStore } : {}),
        ...(parts.webhooks ? { routes: parts.webhooks } : {}),
        ...(opts.webhooks ? { overrides: opts.webhooks } : {}),
      })
    : null;
  if (webhooks) {
    parts.webhooks = webhooks.routes;
    parts.webhookStore = webhooks.store;
  }
  const rawEvents: EventSink = opts.events ?? webhooks?.dispatcher ?? new MemoryEventSink();
  // One debounce for every source of `dep.document.changed` (the rooms and the REST routes): at most
  // one per document per window (BE-055 criterion 2). Other events pass through unchanged.
  const events = new DebouncedEventSink(rawEvents, now);

  const fonts =
    opts.fonts ??
    (config.fontsDir
      ? await loadFontCatalogue(config.fontsDir, config.fontsBaseUrl ?? `${publicUrl}/fonts`, {
          logger,
        })
      : emptyCatalogue());

  const signing = opts.signing ?? signingKey(config.signingJwk ?? undefined);
  if (!opts.signing && !config.signingJwk)
    logger.warn({
      event: 'tokens.ephemeral-key',
      message: 'no DOCEDIT_SIGNING_JWK: minted tokens end with this process',
    });
  const tokens = new TokenService({
    registry: parts.registry,
    users: parts.users,
    serviceId,
    signing,
    now,
    ...(timers ? { defaultLifetimeS: timers.tokenLifetimeS } : {}),
  });

  const pool = new WorkerPool({
    size: config.workers,
    taskTimeoutMs: config.workerTimeoutMs,
    ...(opts.allowWorkerCrash ? { allowCrash: true } : {}),
  });
  const content = new ContentReader({
    logs,
    documents: parts.documents,
    grants: parts.grants,
    checkpoints,
    pool,
    views,
    rebuiltEntries: config.rebuiltEntries,
    responseEntries: config.responseEntries,
  });

  // BE-030 criterion 3: each tenant's own limits are read from its registration (BE-012), so that
  // one tenant at its limit leaves another's alone and a changed limit applies without a restart.
  // Stage 2 (BE-030 criterion 5, BE-063): with `DOCEDIT_VALKEY_URL` the tenant and user counters
  // are shared between nodes. Without it they are in this process's memory.
  const sharedRateStore =
    opts.rateLimits === undefined && config.valkeyUrl !== null
      ? new ValkeyTokenBuckets({ url: config.valkeyUrl })
      : undefined;
  const ownBus =
    opts.bus === undefined && config.valkeyUrl !== null && parts.leases
      ? new ValkeyBus({ node: config.node, url: config.valkeyUrl })
      : undefined;
  const bus = opts.bus ?? ownBus;
  const rateLimits =
    opts.rateLimits ??
    new RateLimits(DEFAULT_RATES, {
      tenantLimits: (tenant) => parts.registry.rateLimits(tenant),
      ...(sharedRateStore ? { store: sharedRateStore } : {}),
    });
  // BE-091: the live-use quotas of the tenants (connections, commit rate) gate the data plane, and
  // their refusals are counted in this node's metrics. Absent when the node composes no quotas.
  // The values come from the parts' quota source when it has one, else from the administration
  // service's cache, so that a change written through `PUT /quotas` applies to the next request
  // (BE-091 criterion 3; docs/adr/0370-w5-BE-091-quota-cache.md).
  const quotaSource: QuotaSource | undefined = parts.quotas ?? parts.quotaAdmin?.source;
  const liveQuotas = quotaSource
    ? new LiveQuotas({
        quotas: quotaSource,
        metrics,
        windowMs: LIVE_QUOTA_WINDOW_MS,
        countRetryMs: LIVE_QUOTA_COUNT_RETRY_MS,
      })
    : undefined;
  // The search index (BE-054; off unless config.searchIndex). Every stored checkpoint queues a job
  // that indexes its words; the words are counted in a worker thread, so no room's event loop does
  // it (criterion 5). The index is PostgreSQL's with a database, the in-memory one without.
  let searchTarget: (IndexTarget & { purgeDocument(t: string, d: string): unknown }) | null = null;
  let searchWorkers: Workers | null = null;
  if (config.searchIndex) {
    const index = parts.pool ? new PgSearchIndex(parts.pool) : new SearchIndex();
    searchTarget = index;
    searchWorkers = new Workers({
      size: SEARCH_WORKER_THREADS,
      timeoutMs: SEARCH_TASK_TIMEOUT_MS,
    });
    if (!parts.search)
      parts.search = { search: async (tenant, q, query) => index.search(tenant, q, query) };
    if (!parts.searchPurge) parts.searchPurge = index;
  }
  // In test mode the node can be restarted in place by a hook (PRO-024 criterion 6; PRO-126).
  const dataPlane = planeOf(config.testMode, opts.createDataPlane ?? defaultDataPlane, {
    ...(searchTarget
      ? {
          onCheckpoint: async (ref: DocRef, seq: number) => {
            await enqueueIndexing(parts.queue, ref.tenant, {
              doc: ref.doc,
              seq,
              visibility: SEARCH_FULL_CLASS,
            });
          },
        }
      : {}),
    logs,
    ownership: parts.ownership,
    grants: parts.grants,
    documents: parts.documents,
    verify: tokens.verifyUser,
    node: config.node,
    limits: rateLimits,
    ...(liveQuotas ? { quotas: liveQuotas } : {}),
    // BE-044: a document references only the assets attached to it or uploaded for it by the submitter.
    ...(parts.assetRegistry
      ? { assets: new RegistryAssetAttachments(parts.logs, parts.assetRegistry) }
      : {}),
    ...(parts.workflows ? { workflows: parts.workflows } : {}),
    // FRW-040: the first view of a participant, from the connection, with its evidence.
    ...(parts.workflows && parts.evidence
      ? {
          participantOpened: (open: ParticipantOpened) =>
            recordParticipantOpened(
              {
                workflows: parts.workflows!,
                grants: parts.grants,
                logs: parts.logs,
                notifier: dataPlane,
                ...(parts.audit ? { audit: parts.audit } : {}),
                now,
                evidence: parts.evidence!,
                events,
              },
              open,
            ).then(() => undefined),
        }
      : {}),
    now,
    checkpoints,
    settings: {
      viewKey,
      ...(config.maxRebaseSteps !== null
        ? { limits: { maxRebaseSteps: config.maxRebaseSteps } }
        : {}),
      // 05 §1 rule 4: discovery and `welcome` announce the same features, so the session accepts
      // in `hello` and `ch.open` what discovery announces (`exports` and `assets` come from the
      // workers, as in `announced` below; U-PRO-103-119, PRO-111 criterion 6).
      features: withTestHooks(
        config,
        config.features ?? [
          ...new Set([
            ...DEFAULT_FEATURES,
            ...(opts.jobHandlers?.[EXPORT_KIND] || config.externalWorkers ? ['exports'] : []),
            ...((opts.assetWorker !== undefined ? opts.assetWorker : config.assetWorker) ||
            config.externalWorkers
              ? ['assets']
              : []),
            ...(parts.workflows ? ['workflow'] : []),
          ]),
        ],
      ),
      // Errors of the data plane go to the same structured log, by name only, with the tenant,
      // document and session they belong to (BE-088 criteria 1 and 2).
      onError: (e: unknown, where: string, context?: ErrorContext) =>
        logger.error({
          event: 'data-plane.error',
          message: where,
          ...(context?.tenant !== undefined ? { tenant: context.tenant } : {}),
          ...(context?.doc !== undefined ? { doc: context.doc } : {}),
          ...(context?.session !== undefined ? { session: context.session } : {}),
          ...errorFields(e),
        }),
      // This process serves `GET /documents/{id}/commits` (commit-routes.ts; BE-038).
      commitsResource: true,
      // The data plane's spans go to the same sink as the REST spans (PRO-044 criterion 1, 4).
      ...(opts.onSpan ? { onSpan: opts.onSpan } : {}),
      ...(config.testMode
        ? {
            testMode: true,
            roomIdleMs: timers!.roomIdleMs,
            helloTimeoutMs: timers!.helloTimeoutMs,
            lease: { durationMs: timers!.nodeLeaseMs },
          }
        : {}),
    },
    allowedOrigins: (tenant) => parts.registry.origins(tenant),
    // G11: the wire shows the host's `sub`, storage holds the surrogate (BE-013).
    users: {
      subsOf: (tenant, surrogates) => parts.users.subsOf(tenant, surrogates),
      surrogateOf: async (tenant, sub) => (await parts.users.resolve(tenant, sub)).surrogate,
    },
    ...(views.visibility ? { visibility: views.visibility } : {}),
    ...(parts.checkpointIndex ? { checkpointIndex: parts.checkpointIndex } : {}),
    ...(parts.audit ? { audit: parts.audit } : {}),
    ...(parts.outbox ? { outbox: parts.outbox } : {}),
    ...(parts.leases ? { leases: parts.leases } : {}),
    ...(bus ? { bus } : {}),
    ...(config.nodeAddress !== null ? { address: config.nodeAddress } : {}),
    // BE-073, BE-074: what the node announces on its lease row, and the regions that route by it.
    ...(config.nodeRegion !== null || config.dedicatedDocument !== null
      ? {
          traits: {
            ...(config.nodeRegion !== null ? { region: config.nodeRegion } : {}),
            ...(config.dedicatedDocument !== null ? { dedicated: config.dedicatedDocument } : {}),
          },
        }
      : {}),
    ...(parts.homeRegions ? { homeRegions: parts.homeRegions } : {}),
    // The room raises refused commits here (PRM-053 criterion 3): the caller's sink or the dispatcher.
    ...(opts.events || webhooks ? { events } : {}),
  });
  // BE-063 criterion 5: with a bus, a change is announced to the owning room on another node, and
  // the announcements of other nodes are applied to this node's rooms.
  const roomNotifier = bus ? new AnnouncingNotifier(dataPlane, bus) : dataPlane;
  const announcements = bus
    ? await listenForAnnouncements(bus, config.node, dataPlane, parts.grants, (e, where) =>
        logger.warn({ event: 'bus.announcement', message: `${where}: ${String(e)}` }),
      )
    : undefined;
  const notify = () => (dataPlane.notify ? dataPlane.notify.bind(dataPlane) : undefined);

  // --- Jobs: maintenance, assets, exports (BE-049 to BE-052; PRO-061; EXP-004 to EXP-008). ------
  const runners: JobRunner[] = [];
  const leaseMs = timers?.jobLeaseMs ?? config.jobLeaseMs;
  // A job's run is a span of the trace its request started (BE-087 criterion 4).
  const jobTracer = new Tracer(opts.onSpan, now);
  const runnerFor = (
    handlers: Readonly<Record<string, JobHandler>>,
    extra: { hooks?: JobHooks; claim?: { defaultLimit: number | null }; concurrency?: number } = {},
  ): JobRunner => {
    const r = new JobRunner({
      queue: parts.queue,
      handlers,
      worker: config.node,
      leaseMs,
      idleMs: config.jobIdleMs,
      retryAfterMs: config.jobRetryAfterMs,
      now,
      ...extra,
      tracer: jobTracer,
      onError: (e, job) =>
        logger.error({ event: 'job.error', tenant: job.tenant, job: job.id, ...errorFields(e) }),
    });
    runners.push(r);
    return r;
  };

  // The bulk sends of templates (FRW-063): a job that makes one document for each row. The handler
  // reads the control plane's dependencies when a job runs; they are built after the runners.
  let bulkSendDeps: HandlerDeps | null = null;
  if (parts.templates) runnerFor({ [BULK_SEND_KIND]: bulkSendHandler(() => bulkSendDeps) });

  const exportHandlers: Record<string, JobHandler> = { ...(opts.jobHandlers ?? {}) };
  if (exportHandlers[EXPORT_KIND] && !exportHandlers[PREVIEW_KIND])
    exportHandlers[PREVIEW_KIND] = exportHandlers[EXPORT_KIND]!;
  // The monthly compile-minute budget (EXP-009): every settled export and preview counts.
  const compileBudget = new CompileBudget(quotaSource ?? null);
  // The seal step (FRW-052 criterion 5, FRW-053): when the final export of a completed workflow has
  // finished, its PDF goes to the signing service, is stored write-once and the workflow becomes
  // `finalised`. A run that stops is reported to the operator through the log and a counter.
  const sealSetup =
    opts.finalSealing ??
    (config.sealing
      ? {
          signing: new HttpSigningClient({
            url: config.sealing.url,
            credential: config.sealing.credential,
            timeoutMs: config.sealing.timeoutMs,
          }),
          retry: { attempts: config.sealing.attempts, delaysMs: config.sealing.delaysMs },
          retainMs: config.sealing.retentionDays * 24 * 60 * 60 * 1000,
        }
      : null);
  let sealer: FinalSealer | null = null;
  if (sealSetup) {
    if (!parts.workflows || !parts.sealedPdfs || !parts.anchors)
      throw new Error(
        'sealing needs the workflow store and the write-once stores (parts.workflows, parts.sealedPdfs, parts.anchors)',
      );
    sealer = new FinalSealer({
      workflows: parts.workflows,
      grants: parts.grants,
      logs: parts.logs,
      notifier: roomNotifier,
      ...(parts.audit ? { audit: parts.audit } : {}),
      now,
      controlWaitMs: 500,
      sealed: parts.sealedPdfs,
      anchors: parts.anchors,
      signing: sealSetup.signing,
      retry: sealSetup.retry,
      sleep: sealSetup.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      retainMs: sealSetup.retainMs,
      objects: parts.objects,
      queue: parts.queue,
      events,
      // The visible appearances at the signature and initials fields (FRW-057).
      ...(parts.evidence
        ? {
            appearances: (ref, workflow, job) =>
              appearanceRequestFor(
                { objects: parts.objects, content, evidence: parts.evidence! },
                ref,
                workflow,
                job,
              ),
          }
        : {}),
      // The operator's alert (FRW-052 criterion 5): an error line and a counter to alert on. The
      // audit entry `workflow.finalisation_failed` is written by the step itself.
      alert: (a) => {
        logger.error({
          event: a.kind,
          tenant: a.tenant,
          doc: a.doc,
          code: a.code,
          message: 'finalisation stopped before the seal was stored; the workflow stays completed',
        });
        metrics.inc(
          'docedit_finalisation_stopped_total',
          'Runs of the seal step that stopped; the workflow stays completed (FRW-052, FRW-053)',
          { reason: a.reason, code: a.code, retryable: String(a.retryable) },
        );
      },
    });
  }
  const sealing = sealer;
  const runSeal = (ref: { tenant: string; doc: string }): Promise<unknown> =>
    sealing === null
      ? Promise.resolve(null)
      : sealing.sealCompletedWorkflow(ref).catch((e: unknown) => {
          logger.error({
            event: 'workflow.seal.error',
            tenant: ref.tenant,
            doc: ref.doc,
            ...errorFields(e),
          });
          return null;
        });
  const hooks = exportHooks({
    notify,
    events,
    restPath: REST_PATH,
    now,
    ...(sealing
      ? {
          finalExportCompleted: (job: JobRecord) => {
            if (job.doc) void runSeal({ tenant: job.tenant, doc: job.doc });
          },
        }
      : {}),
    ...(parts.versions ? { versions: parts.versions } : {}),
    ...(parts.audit ? { audit: parts.audit } : {}),
    versionFailed: (job) =>
      logger.error({
        event: 'export.version',
        tenant: job.tenant,
        job: job.id,
        message: 'export version not stored',
      }),
    metered: (job, outcome, ranMs) => {
      if (outcome.state === 'lost') return;
      compileBudget.record(job.tenant, ranMs, now());
      meter.add(
        job.tenant,
        job.kind === PREVIEW_KIND ? DRIVERS.previewCompiles : DRIVERS.finalCompiles,
        1,
      );
      meter.add(job.tenant, DRIVERS.compileSeconds, ranMs / 1000, { kind: job.kind });
    },
  });
  let runner: JobRunner | null = null;
  let exportWorkers: JobWorkerPool | null = null;
  let autoscaler: Autoscaler | null = null;
  if (Object.keys(exportHandlers).length) {
    // Previews and requested exports each get a runner, so a backlog of one never holds the
    // other (EXP-007 criterion 1); a tenant's running jobs of a kind stay within its limit.
    const claim = { defaultLimit: config.exportTenantConcurrency };
    const others = Object.fromEntries(
      Object.entries(exportHandlers).filter(([k]) => k !== PREVIEW_KIND),
    );
    if (opts.exportScaling) {
      // BE-065: the export workers follow the queue depth, between the floor and the ceiling. Each
      // claims with the same options as the single runner, so priorities and tenant limits hold.
      exportWorkers = new JobWorkerPool({
        queue: parts.queue,
        handlers: others,
        name: `${config.node}-export`,
        leaseMs,
        idleMs: config.jobIdleMs,
        retryAfterMs: config.jobRetryAfterMs,
        claim,
        hooks,
        onError: (e) => logger.error({ event: 'job.error', ...errorFields(e) }),
      });
      autoscaler = new Autoscaler({
        queue: parts.queue,
        pool: exportWorkers,
        policy: opts.exportScaling.policy,
      });
    } else runner = runnerFor(others, { hooks, claim });
    if (exportHandlers[PREVIEW_KIND])
      runnerFor({ [PREVIEW_KIND]: exportHandlers[PREVIEW_KIND]! }, { hooks, claim });
  }

  const exportUrlKeys = assetUrlKeys(config.assetUrlKey);
  const uploads = assetUploads({
    objects: parts.objects,
    assets,
    s3: config.s3,
    origin: config.assetOrigin,
    urlKeys: exportUrlKeys,
    uploadSeconds: config.uploadSeconds,
    urlLifetimeMs: config.signedUrlSeconds * 1000,
  });
  const assetWorker =
    opts.assetWorker !== undefined
      ? opts.assetWorker
      : config.assetWorker
        ? { sandbox: podmanSandbox() }
        : null;
  if (assetWorker)
    runnerFor({
      [ASSET_JOB_KIND]: assetJobHandler({
        objects: workerObjects(parts.objects),
        sandbox: assetWorker.sandbox,
        ...(assetWorker.allowUnsandboxed ? { allowUnsandboxed: true } : {}),
        registry: parts.assetRegistry,
        notify,
        now,
        stored: (tenant, bytes) => meter.add(tenant, DRIVERS.storedBytes, bytes, { kind: 'asset' }),
      }),
    });

  // Word imports (EXP-098): one runner of kind `import`, with the notifications and the version.
  if (opts.importer)
    runnerFor(
      {
        [IMPORT_KIND]: importJobHandler({
          importer: opts.importer,
          assets,
          registry: parts.assetRegistry,
          grants: parts.grants,
          content,
          dataPlane,
        }),
      },
      {
        hooks: importHooks({
          notify,
          events,
          now,
          ...(parts.versions ? { versions: parts.versions } : {}),
          versionFailed: (job) =>
            logger.error({
              event: 'import.version',
              tenant: job.tenant,
              job: job.id,
              message: 'import version not stored',
            }),
        }),
      },
    );

  // Scheduled maintenance (BE-052): one job per task and slot in the queue.
  const purge =
    parts.purgeStore && parts.audit
      ? new DocumentPurge({
          store: parts.purgeStore,
          objects: parts.objects,
          audit: parts.audit,
          ...(parts.searchPurge ? { search: parts.searchPurge } : {}),
          retentionMs: config.purgeAfterDays * DAY_MS,
          now,
        })
      : null;
  const thinning =
    parts.thinningStore && parts.retention && parts.audit
      ? new PayloadThinning({
          store: parts.thinningStore,
          retention: parts.retention,
          audit: parts.audit,
          now,
        })
      : null;
  // Thinning of old checkpoints (HIS-030): a checkpoint that replaces older ones is compared with a
  // replay of the log first (BE-020 criterion 5), and a mismatch raises the alert counter.
  const checkpointThinning =
    parts.checkpointThinningStore && parts.audit
      ? new CheckpointThinning({
          store: parts.checkpointThinningStore,
          objects: parts.objects,
          audit: parts.audit,
          now,
          verify: async (ref, seq) =>
            (
              await gateThinning(
                {
                  logs,
                  checkpoints,
                  index: parts.checkpointIndex,
                  audit: parts.audit,
                },
                ref,
                seq,
                (verdict) => {
                  // The alert counter lives in the data plane's registry (BE-020 criterion 5).
                  (
                    dataPlane as unknown as DataPlaneRegistry
                  ).metricsRegistry?.checkpointMismatches.inc({
                    tenant: ref.tenant,
                  });
                  logger.error({
                    event: 'checkpoint.mismatch',
                    tenant: ref.tenant,
                    message: `checkpoint ${verdict.seq} of ${ref.doc} differs from its replay`,
                  });
                },
              )
            ).proceed,
          onUnverifiable: (ref, seq, error) =>
            logger.error({
              event: 'checkpoints.thin.unverifiable',
              tenant: ref.tenant,
              message: `${ref.doc} at ${seq}: ${error instanceof Error ? error.message : String(error)}`,
            }),
        })
      : null;
  const tasks: ScheduledTask[] = [
    ...(checkpointThinning ? [checkpointThinningTask(checkpointThinning)] : []),
    // Thinning of old payloads for tenants and documents whose policy says so (HIS-032); the
    // scheduler hands the task the documents under a legal hold, and the task leaves them alone.
    ...(thinning ? [payloadThinningTask(thinning)] : []),
    // The purge of deleted documents past their retention (HIS-039); held documents are left alone.
    ...(purge
      ? [
          {
            name: 'documents.purge',
            everyMs: 60 * 60 * 1000,
            deletes: true,
            forTenant: async (tenant: string, at: number, scope: { held: ReadonlySet<string> }) =>
              (await purge.run(tenant, scope.held, at)).purged.length,
          } satisfies ScheduledTask,
        ]
      : []),
    // The deadline and the reminders of running workflows (FRW-034): one run a minute for each
    // tenant; the sweep raises each reminder once however many instances run it.
    ...(parts.workflows && parts.reminders
      ? [
          {
            name: 'workflow.schedule',
            everyMs: 60 * 1000,
            forTenant: async (tenant: string) => {
              const done = await sweepTenant(
                {
                  workflows: parts.workflows!,
                  reminders: parts.reminders!,
                  grants: parts.grants,
                  logs: parts.logs,
                  notifier: roomNotifier,
                  ...(parts.audit ? { audit: parts.audit } : {}),
                  now,
                  events,
                },
                tenant,
              );
              for (const f of done.failed)
                logger.error({
                  event: 'workflow.schedule.error',
                  tenant,
                  message: `${f.doc}: ${f.error}`,
                });
              return done.expired.length + done.reminded.length;
            },
          } satisfies ScheduledTask,
        ]
      : []),
    // The seal step of completed workflows (FRW-053): finds a final export that has finished and
    // seals it, so that a run that stopped, or a process that restarted, is taken up again.
    ...(sealing && parts.workflows?.listCompleted
      ? [
          {
            name: 'workflow.seal',
            everyMs: 60 * 1000,
            forTenant: async (tenant: string) => {
              let sealed = 0;
              for (const w of await parts.workflows!.listCompleted!(tenant)) {
                const out = await runSeal({ tenant, doc: w.doc });
                if ((out as { status?: string } | null)?.status === 'sealed') sealed += 1;
              }
              return sealed;
            },
          } satisfies ScheduledTask,
        ]
      : []),
    {
      name: 'idempotency.purge',
      everyMs: 60 * 60 * 1000,
      deletes: true,
      forTenant: (tenant, at) => parts.idempotency.purge(tenant, at),
    },
    // Abandoned uploads (BE-046 criterion 3): the one copy of the sweep, tested in asset-sweep.ts.
    // Legal holds (BE-046 criterion 4): the scheduler hands the sweep the held documents (BE-052).
    abandonedUploadsTask({ assets: parts.assetRegistry, objects: parts.objects, batch: 500 }),
  ];
  if (parts.audit instanceof PgAuditStore) tasks.push(auditPartitionsTask(parts.audit));
  const scheduler = config.scheduler
    ? new Scheduler({
        queue: parts.queue,
        tasks,
        tenants: () => parts.registry.list(),
        // A hold is on a document (08 §11): deleting tasks keep the held documents' data.
        ...(parts.holds
          ? { heldDocuments: (tenant: string) => parts.holds!.heldDocuments(tenant) }
          : {}),
        metrics,
        now,
        onError: (e, task) =>
          logger.error({ event: 'schedule.error', message: task, ...errorFields(e) }),
      })
    : null;
  if (scheduler) {
    runnerFor({ [SCHEDULE_KIND]: scheduler.handler });
    await scheduler
      .ensure()
      .catch((e: unknown) =>
        logger.error({ event: 'schedule.error', message: 'ensure', ...errorFields(e) }),
      );
  }
  if (searchTarget && searchWorkers) {
    const workers = searchWorkers;
    runnerFor({
      [SEARCH_INDEX_KIND]: createSearchIndexHandler({
        checkpoints: {
          // Only the class `full` is indexed: it is what a service credential reads (ADR 0019).
          readCheckpoint: async (tenant, doc, seq, visibility) =>
            visibility === SEARCH_FULL_CLASS
              ? ((await checkpoints.get({ tenant, doc }, seq))?.doc ?? null)
              : null,
        },
        index: searchTarget,
        tokenise: async (content) =>
          new Map((await workers.run('searchTokens', { doc: content })).tokens),
      }),
    });
  }
  for (const r of runners) r.start();

  // The scaler reads the queue depth on a timer and whenever a job is queued (BE-065); one reading
  // at a time, and one more after it when another was asked for meanwhile.
  let scaling: Promise<void> = Promise.resolve();
  let ticking = false;
  let again = false;
  let stopping = false;
  const rescale = (): void => {
    if (!autoscaler || stopping) return;
    if (ticking) {
      again = true;
      return;
    }
    ticking = true;
    const scaler = autoscaler;
    scaling = scaler
      .tick()
      .then(
        () => undefined,
        (e: unknown) => logger.error({ event: 'autoscale.error', ...errorFields(e) }),
      )
      .finally(() => {
        ticking = false;
        if (again) {
          again = false;
          rescale();
        }
      });
  };
  const scaleTimer = autoscaler ? setInterval(rescale, opts.exportScaling!.tickMs) : null;
  scaleTimer?.unref();
  rescale();

  const processMetrics = registerProcessMetrics(metrics);
  metrics.gauge(
    'docedit_jobs',
    'Queued and running jobs by kind, priority and state (BE-050 criterion 5).',
    async () =>
      (await parts.queue.depth()).flatMap((d) => [
        {
          labels: { kind: d.kind, priority: String(d.priority), state: 'queued' },
          value: d.queued,
        },
        {
          labels: { kind: d.kind, priority: String(d.priority), state: 'running' },
          value: d.running,
        },
      ]),
  );

  const announced = withTestHooks(
    config,
    config.features ?? [
      ...new Set([
        ...(dataPlane.features ?? []),
        // `exports` only when a compile worker can serve the queue (ADR 0054; `exports.states`).
        ...(exportHandlers[EXPORT_KIND] || config.externalWorkers ? ['exports'] : []),
        ...(assetWorker || config.externalWorkers ? ['assets'] : []),
        ...(parts.workflows ? ['workflow'] : []),
      ]),
    ],
  );

  // Read-only routes through a read replica (BE-064): the replica's own content reader, over the
  // same immutable checkpoints, answers a read only when its log holds what the read needs.
  let reads: ReadRouter<ReadStores> | null = null;
  let readSessions: ReadSessions | null = null;
  let replicaDeps: Partial<HandlerDeps> | null = null;
  const replica = parts.replica;
  if (replica) {
    const replicaContent = new ContentReader({
      logs: replica.logs,
      documents: replica.documents,
      grants: replica.grants,
      checkpoints,
      pool,
      views,
      rebuiltEntries: config.rebuiltEntries,
      responseEntries: config.responseEntries,
    });
    reads = new ReadRouter<ReadStores>({
      primary: { documents: parts.documents, content },
      replica: {
        store: { documents: replica.documents, content: replicaContent },
        appliedSeq: (tenant, doc) => headSeq(replica.logs, { tenant, doc }),
        primarySeq: (tenant, doc) => headSeq(logs, { tenant, doc }),
      },
      metrics,
      ...(readLagDocuments !== undefined ? { lagDocuments: readLagDocuments } : {}),
    });
    readSessions = new ReadSessions(readSessionsMax!);
    replicaDeps = {
      logs: replica.logs,
      documents: replica.documents,
      grants: replica.grants,
      content: replicaContent,
      ...(replica.versions ? { versions: replica.versions } : {}),
    };
  }
  const pinnedCache = opts.pinnedCache
    ? new PinnedCache({
        cachingEnabled: (tenant) => opts.pinnedCache!.enabled(tenant),
        maxEntries: opts.pinnedCache.maxEntries,
      })
    : null;

  const controlDeps: HandlerDeps = {
    ...(reads ? { reads } : {}),
    ...(readSessions ? { readSessions } : {}),
    ...(replicaDeps ? { replicaDeps } : {}),
    ...(pinnedCache ? { pinnedCache } : {}),
    comparePool: pool,
    documents: parts.documents,
    grants: parts.grants,
    logs,
    // The content at seq 0 of a new document is serialised in the pool (BE-001 criterion 3).
    checkpoints: serialisedInPool(checkpoints, pool),
    assets,
    users: parts.users,
    ...(parts.audit ? { audit: parts.audit } : {}),
    ...(parts.readMarkers ? { readMarkers: parts.readMarkers } : {}),
    ...(parts.threads ? { threads: parts.threads } : {}),
    ...(parts.versions ? { versions: parts.versions } : {}),
    tokens,
    queue: parts.queue,
    content,
    views,
    events,
    notifier: roomNotifier,
    dataPlane,
    publicUrl,
    restPath: REST_PATH,
    wsPath: WS_PATH,
    ...(parts.leases ? { placement: new Placement(parts.leases) } : {}),
    ...(parts.homeRegions ? { homeRegions: parts.homeRegions } : {}),
    features: announced,
    exportTargets: config.exportTargets,
    signedUrlMs: config.signedUrlSeconds * 1000,
    cursors: new Cursors(config.cursorSecret ?? randomBytes(32)),
    now,
    onJobQueued: () => {
      for (const r of runners) r.poke();
      rescale();
    },
    assetRegistry: parts.assetRegistry,
    uploads,
    ...(config.assetOrigin && exportUrlKeys
      ? {
          exportUrl: (tenant: string, job: string, name: string, expiresAt: number) =>
            signExportUrl({
              origin: config.assetOrigin!,
              tenant,
              job,
              name,
              expiresAt,
              keys: exportUrlKeys,
            }),
        }
      : {}),
    uploadSeconds: config.uploadSeconds,
    ...(timers ? { regionLeaseMs: timers.regionLeaseMs } : {}),
    fonts: () => fonts,
    exportPolicy: {
      previewWindowMs: timers?.previewWindowMs ?? config.previewWindowMs,
      cacheMaxAgeMs: config.exportCacheMaxAgeMs,
      classVersion: config.exportClassVersion,
      tenantConcurrency: config.exportTenantConcurrency,
      ...(config.exportProofKey ? { proofKey: config.exportProofKey } : {}),
    },
    ...(parts.outbox ? { outbox: parts.outbox } : {}),
    outboxWaitMs: config.outboxWaitMs,
    meter,
    ...(parts.audit ? { audit: parts.audit } : {}),
    ...(parts.webhooks ? { webhooks: parts.webhooks } : {}),
    ...(webhooks ? { webhookDispatcher: webhooks.dispatcher } : {}),
    ...(parts.retention ? { retention: parts.retention } : {}),
    ...(parts.historyVisibility ? { historyVisibility: parts.historyVisibility } : {}),
    ...(parts.quotaAdmin ? { quotaAdmin: parts.quotaAdmin } : {}),
    tenantRegistry: parts.registry,
    ...(parts.holds ? { holds: parts.holds } : {}),
    ...(erasures ? { erasures } : {}),
    ...(tombstones ? { tombstones } : {}),
    ...(parts.workflows ? { workflows: parts.workflows } : {}),
    ...(parts.templates ? { templates: parts.templates } : {}),
    ...(parts.accessCodes ? { accessCodes: parts.accessCodes } : {}),
    ...(parts.consentTexts ? { consentTexts: parts.consentTexts } : {}),
    ...(parts.evidence ? { evidence: parts.evidence } : {}),
    ...(parts.sealedPdfs ? { sealedPdfs: parts.sealedPdfs } : {}),
    ...(sealing ? { sealing: true } : {}),
    ...(parts.policyHook ? { policyHook: parts.policyHook } : {}),
    ...(parts.search ? { search: parts.search } : {}),
    compileBudget,
    ...(liveQuotas ? { liveQuotas } : {}),
    ...(quotaSource ? { quotaSource } : {}),
    ...(config.maxRebaseSteps !== null ? { rebaseWindow: config.maxRebaseSteps } : {}),
    ...(opts.importer ? { importsOffered: true } : {}),
  };
  bulkSendDeps = controlDeps;
  const handlers = createHandlers(controlDeps);

  const ready = () => (parts.readiness ? parts.readiness() : readiness(parts.pool));
  const probe =
    (fn: () => Promise<Reply>): PlainHandler =>
    () =>
      fn();
  const plain: Record<string, PlainHandler> = {
    '/.well-known/jwks.json': probe(async () => ({
      status: 200,
      body: tokens.jwks(),
      headers: { 'Cache-Control': 'no-cache' },
    })),
    '/healthz': probe(async () => ({ status: 200, body: { live: true } })),
    '/readyz': probe(async () => {
      const r = await ready();
      return { status: r.ready ? 200 : 503, body: r, headers: { 'Cache-Control': 'no-store' } };
    }),
  };
  if (config.metricsToken) {
    const want = Buffer.from(`Bearer ${config.metricsToken}`, 'utf8');
    plain['/metrics'] = async (req) => {
      const got = Buffer.from(String(req.headers.authorization ?? ''), 'utf8');
      if (got.length !== want.length || !timingSafeEqual(got, want))
        return {
          status: 401,
          body: { code: 'unauthenticated' },
          headers: { 'WWW-Authenticate': 'Bearer' },
        };
      const text = `${await metrics.render()}${dataPlane.metrics?.() ?? ''}`;
      return {
        status: 200,
        bytes: Buffer.from(text, 'utf8'),
        headers: { 'Content-Type': 'text/plain; version=0.0.4', 'Cache-Control': 'no-store' },
      };
    };
  }
  const prefixes: Record<string, PlainHandler> = { '/fonts/': fontFileHandler(() => fonts) };
  if (config.testMode)
    prefixes['/_test/'] = testHooks({ tokens, dataPlane, timers: timers!, logger });

  const pipeline = new Pipeline({
    tokens,
    registry: parts.registry,
    users: parts.users,
    handlers,
    plain,
    prefixes,
    restPath: REST_PATH,
    logger,
    maxBodyBytes: config.maxBodyBytes,
    maxContentBodyBytes: config.maxContentBodyBytes,
    now,
    idempotency: parts.idempotency,
    rateLimits,
    idempotencyTtlMs: timers?.idempotencyTtlMs ?? config.idempotencyTtlMs,
    idempotencyWaitMs: config.idempotencyWaitMs,
    unavailableRetryAfterS: config.unavailableRetryAfterS,
    ...(opts.onSpan ? { onSpan: opts.onSpan } : {}),
  });

  server.on('request', (req, res) => {
    void pipeline.handle(req, res);
  });
  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://service.invalid').pathname;
    if (path === WS_PATH) dataPlane.handleUpgrade(req, socket, head);
    else socket.destroy();
  });

  let closed: Promise<void> | null = null;
  return {
    url: listening,
    server,
    parts,
    checkpoints,
    assets,
    tokens,
    dataPlane,
    content,
    pool,
    events: rawEvents,
    webhooks: webhooks?.dispatcher ?? null,
    runner,
    runners,
    searchWorkers,
    scheduler,
    metrics,
    meter,
    fonts,
    exportWorkers,
    autoscaler,
    reads,
    pinnedCache,
    sealer,
    ready,
    close: () =>
      (closed ??= (async () => {
        stopping = true;
        if (scaleTimer) clearInterval(scaleTimer);
        processMetrics.stop();
        await scaling;
        // Each export worker finishes the job it runs before it stops (BE-065 criterion 3).
        await exportWorkers?.stop();
        await Promise.all(runners.map((r) => r.stop()));
        await searchWorkers?.close().catch(() => undefined);
        announcements?.close();
        await dataPlane.close().catch(() => undefined);
        sharedRateStore?.close();
        await ownBus?.close();
        // The last change of a burst that still waits for its window is raised before the sends drain.
        events.close();
        // Sends already started finish; each is bounded by the egress timeout (BE-056).
        await webhooks?.dispatcher.drain().catch(() => undefined);
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await pool.close();
        if (db) await db.end().catch(() => undefined);
        if (replicaDb) await replicaDb.end().catch(() => undefined);
        if (purgeDb) await purgeDb.end().catch(() => undefined);
      })()),
  };
}
