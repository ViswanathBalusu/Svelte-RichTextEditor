/**
 * `pnpm --filter @docedit/export-worker start`: the export worker process (EXP-001; 09 §9.5).
 *
 * A long-running queue consumer with no HTTP port. It claims `export` jobs from the control plane's
 * PostgreSQL queue, reads the content at each job's `seq` from the service's database and bucket,
 * converts, compiles in a single-use Podman sandbox, and stores the outputs under the job's prefix;
 * the document service, running separately on the same database and bucket, signs their URLs.
 *
 * Settings are the document service's (configFromEnv): DOCEDIT_DATABASE_URL (the service role) and
 * the S3 settings are required; DOCEDIT_NODE_ID, DOCEDIT_JOB_LEASE_MS, DOCEDIT_JOB_IDLE_MS and
 * DOCEDIT_JOB_RETRY_MS as for the service. The sandbox: DOCEDIT_EXPORT_IMAGE, DOCEDIT_CONTAINER_CLI
 * (default podman), and on Windows or macOS DOCEDIT_PODMAN_MACHINE (found automatically when a
 * machine runs). The process exits with code 1, and logs why, when a required setting is missing
 * or the sandbox cannot run (Podman missing, image not built, limits not applicable, host mounts).
 */
import {
  AssetStore,
  configFromEnv,
  createLogger,
  createPool,
  ObjectCheckpointStore,
  PgDocumentStore,
  PgGrantStore,
  PgJobQueue,
  PgLogStore,
  S3ObjectStore,
} from '@docedit/document-service';
import { imageFontManifest } from './fonts.ts';
import { imageFontCheck } from './image-font-files.ts';
import { metricsLogFields } from './metrics-log.ts';
import { IMAGE } from './sandbox.ts';
import { sandboxReady } from './sandbox-ready.ts';
import { createExportWorker } from './worker.ts';

const logger = createLogger();
const stop = (message: string): never => {
  logger.error({ event: 'export-worker.failed', message });
  process.exit(1);
};

const config = configFromEnv();
if (!config.databaseUrl)
  stop('DOCEDIT_DATABASE_URL is not set: the worker takes jobs from PostgreSQL');
if (!config.s3) stop('DOCEDIT_S3_ENDPOINT or DOCEDIT_S3_HOST is not set: outputs go to the bucket');
const ready = await sandboxReady();
if (!ready.ok) stop(`the sandbox cannot run here: ${ready.reason}`);
try {
  // Read once at start, so that a broken image stops the worker before it claims a job.
  await imageFontManifest(IMAGE);
} catch {
  stop(`the font manifest of ${IMAGE} cannot be read`);
}

const pool = createPool({ connectionString: config.databaseUrl!, connectionTimeoutMillis: 5000 });
pool.on('error', () => {});
const grants = new PgGrantStore(pool);
const objects = new S3ObjectStore(config.s3!);
const logs = new PgLogStore(pool, { permissions: (ref) => grants.current(ref) });
const worker = createExportWorker({
  queue: new PgJobQueue(pool),
  deps: {
    stores: {
      logs,
      checkpoints: new ObjectCheckpointStore(objects),
      documents: new PgDocumentStore(pool),
      chainHeadAt: (ref, seq) => logs.chainHeadAt(ref, seq),
    },
    outputs: new AssetStore(objects),
    fonts: () => imageFontManifest(IMAGE),
    // EXP-047 criterion 2: every face of the manifest must be a file of the image under its hash,
    // or the job fails with font_file_missing or font_file_mismatch before it converts.
    checkFontFiles: imageFontCheck(IMAGE),
    image: IMAGE,
    // Every attempt, named by how it ended (metrics-log.ts): `export.completed`,
    // `export.attempt_failed` or `export.attempt_aborted`, with the stage times of EXP-060 and the
    // log size of EXP-064. The error's name and code are the `export.failed` line of onError below.
    onMetrics: (m, job) => logger.info(metricsLogFields(m, job)),
  },
  worker: `${config.node}-export`,
  leaseMs: config.jobLeaseMs,
  idleMs: config.jobIdleMs,
  retryAfterMs: config.jobRetryAfterMs,
  onError: (e, job) =>
    logger.error({
      event: 'export.failed',
      tenant: job.tenant,
      job: job.id,
      error: e instanceof Error ? e.name : typeof e,
      ...(e instanceof Error && 'code' in e && typeof e.code === 'string' ? { code: e.code } : {}),
    }),
});
worker.start();
logger.info({
  event: 'export-worker.started',
  message: `taking export jobs; sandbox ${ready.reason}; image ${IMAGE}`,
});

const shutdown = () => {
  logger.info({ event: 'export-worker.stopping' });
  void worker
    .stop()
    .then(() => pool.end())
    .finally(() => process.exit(0));
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
