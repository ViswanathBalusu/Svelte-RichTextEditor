/**
 * `node apps/reference-host/scripts/setup.ts`: prepares the demo stack once PostgreSQL and the S3
 * store answer (UX-091 criteria 1, 3, 4; BE-005 criterion 2). Every step can be repeated.
 *
 * 1. The secrets of this stack: generated the first time into the data directory, demo-only.
 * 2. The bucket, and CORS rules so that the PDF viewer can fetch exported files by signed URL.
 * 3. The database, the service role (no superuser, no BYPASSRLS; BE-011) and the migrations, run
 *    as the schema owner.
 * 4. The tenant registration the document service applies at start (DOCEDIT_TENANTS_FILE; BE-012):
 *    the tenant, the host's public key for host-signed tokens, the host's API key (as a hash) and
 *    the allowed origins, all from the stack's configuration.
 *
 * A database created by this run makes the host's catalogue stale, so the catalogue is removed.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPool, ensureServiceRole, migrate } from '@docedit/document-service';
import { allowViewerOrigins, ensureBucket, type S3Target } from './lib/s3.ts';
import {
  allowedOrigins,
  dataDir,
  endpoints,
  ensureSecrets,
  secretsDir,
  seedTenant,
  setting,
  stackSettings,
  tenantRegistration,
} from './lib/stack.ts';

const s = stackSettings();
const dir = dataDir();
const e = endpoints(s);
const tenant = seedTenant();
await mkdir(dir, { recursive: true });

const secrets = await ensureSecrets(tenant.id, dir, secretsDir());

const target: S3Target = {
  endpoint: e.s3Url,
  region: setting(s, 'DOCEDIT_DEMO_S3_REGION'),
  accessKey: setting(s, 'DOCEDIT_DEMO_S3_ACCESS_KEY'),
  secretKey: setting(s, 'DOCEDIT_DEMO_S3_SECRET_KEY'),
};
const bucket = setting(s, 'DOCEDIT_DEMO_S3_BUCKET');
const bucketState = await ensureBucket(target, bucket);
const cors = await allowViewerOrigins(target, bucket, allowedOrigins(s));

const database = setting(s, 'DOCEDIT_DEMO_PG_DATABASE');
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(database))
  throw new Error('DOCEDIT_DEMO_PG_DATABASE must be a plain lower-case identifier');
const root = createPool({ connectionString: e.adminDatabaseUrl('postgres'), max: 1 });
let created = false;
try {
  const c = await root.connect();
  try {
    await ensureServiceRole(
      c,
      setting(s, 'DOCEDIT_DEMO_PG_SERVICE_USER'),
      setting(s, 'DOCEDIT_DEMO_PG_SERVICE_PASSWORD'),
    );
    const exists = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if (exists.rowCount === 0) {
      await c.query(`CREATE DATABASE ${database}`);
      created = true;
    }
  } finally {
    c.release();
  }
} finally {
  await root.end();
}

const admin = createPool({ connectionString: e.adminDatabaseUrl(database), max: 1 });
let applied: string[];
try {
  const c = await admin.connect();
  try {
    applied = await migrate(c);
  } finally {
    c.release();
  }
} finally {
  await admin.end();
}

const registration = tenantRegistration(tenant, secrets, allowedOrigins(s));
await writeFile(join(dir, 'tenants.json'), `${JSON.stringify(registration, null, 2)}\n`, 'utf8');

if (created) await rm(join(dir, 'catalogue.json'), { force: true });

const report = {
  bucket: bucketState,
  bucketCors: cors.ok ? 'set' : `not set (HTTP ${cors.status}: ${cors.detail})`,
  database: created ? 'created' : 'exists',
  migrations: applied.length ? applied : 'none to apply',
  tenant: tenant.id,
  origins: allowedOrigins(s),
};
await writeFile(join(dir, 'setup.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`setup: ${JSON.stringify(report)}`);
