/**
 * `@docedit/document-service`: the reference document service (06). Phase 1a holds the storage
 * layer only: the storage ports (06 §14), their PostgreSQL and in-memory implementations, the
 * migrations, and the fault hooks the S3 simulation uses against PostgreSQL (SYN-047).
 */
export * from './storage/types.ts';
export { createPool, inTenant, beginForTenant, isUuid } from './storage/db.ts';
export {
  PgLogStore,
  type AppendHooks,
  type PgLogStoreOptions,
  type ChainVerdict,
} from './storage/log-store.ts';
export { PgGrantStore, diffPermissions, readPermissions } from './storage/grant-store.ts';
export { PgDocumentStore } from './storage/document-store.ts';
export { MemoryStore } from './storage/memory.ts';
export { appendWithFault, type Fault, type FailPoint } from './storage/faults.ts';
export {
  migrate,
  loadMigrations,
  schemaVersion,
  expectedSchemaVersion,
  ensureServiceRole,
  MIGRATIONS_DIR,
} from './storage/migrate.ts';
export {
  encodeCommit,
  decodePayload,
  chainHash,
  GENESIS_HASH,
  type CommitPayload,
  type CommitMetadata,
} from './storage/codec.ts';

// The process and the control plane (PLAN-1a packet A2): the composition, tokens and credentials,
// tenant registrations, the job queue whose `export` handler the compile worker registers, and
// object storage.
export {
  startService,
  pgParts,
  memoryParts,
  readiness,
  REST_PATH,
  WS_PATH,
  type Service,
  type ServiceParts,
  type StartOptions,
  type Readiness,
} from './server.ts';
export { configFromEnv, DEFAULTS as SERVICE_DEFAULTS, type ServiceConfig } from './config.ts';
export { createLogger, redactUrl, SILENT, type Logger, type LogFields } from './log.ts';
export {
  TokenService,
  connectionFor,
  newApiKey,
  signingKey,
  type ServiceIdentity,
  type SigningKey,
} from './control-plane/tokens.ts';
export {
  MemoryTenantRegistry,
  PgTenantRegistry,
  hashSecret,
  type TenantRegistry,
  type TenantKey,
  type KeyUse,
} from './control-plane/tenants.ts';
export { MemoryUserDirectory, PgUserDirectory, type UserDirectory } from './control-plane/users.ts';
export { applySeed, parseSeed, type SeedFile, type TenantSeed } from './control-plane/seed.ts';
export {
  MemoryJobQueue,
  QUEUE_DEFAULTS,
  type JobQueue,
  type JobRecord,
  type JobRef,
  type JobState,
  type NewJob,
} from './control-plane/jobs/queue.ts';
export { PgJobQueue } from './control-plane/jobs/pg.ts';
export {
  JobRunner,
  JobFailure,
  type JobHandler,
  type JobContext,
} from './control-plane/jobs/runner.ts';
export type { ExportOutputs } from './control-plane/handlers.ts';
export { MemoryEventSink, type EventSink, type DepEvent } from './control-plane/events.ts';
export {
  MemoryObjectStore,
  TenantObjects,
  objectKeys,
  ObjectExistsError,
  ForeignKeyError,
  type ObjectStore,
} from './objects/store.ts';
export { S3ObjectStore, type S3Settings } from './objects/s3.ts';
export { ObjectCheckpointStore, AssetStore } from './objects/checkpoints.ts';

// The control plane's phase 1b (packet C; ADR 0054): job kinds and priorities of exports and
// previews, idempotency keys, assets, the scheduler, metrics, test mode.
export {
  EXPORT_KIND,
  PREVIEW_KIND,
  EXPORT_KINDS,
  EXPORT_PRIORITIES,
  exportRequestKey,
  type ExportPolicy,
} from './control-plane/exports.ts';
export type { ClaimOptions, QueueDepth } from './control-plane/jobs/queue.ts';
export type { JobHooks, JobOutcome } from './control-plane/jobs/runner.ts';
export {
  MemoryIdempotencyStore,
  PgIdempotencyStore,
  type IdempotencyStore,
} from './control-plane/idempotency.ts';
export {
  MemoryAssetRegistry,
  PgAssetRegistry,
  type AssetRecord,
  type AssetRegistry,
} from './control-plane/assets.ts';
export {
  Scheduler,
  SCHEDULE_KIND,
  PLATFORM_TENANT,
  type ScheduledTask,
} from './control-plane/scheduler.ts';
export { Metrics, TenantMeter, DRIVERS } from './control-plane/metrics.ts';
export { TEST_TIMERS, type TestTimers } from './control-plane/test-hooks.ts';
export {
  loadFontCatalogue,
  type FontCatalogue,
  type FontManifestBody,
} from './control-plane/fonts.ts';
export { checkConfig, type Environment } from './config.ts';
