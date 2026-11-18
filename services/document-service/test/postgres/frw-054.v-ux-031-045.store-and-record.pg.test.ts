// FRW-054 criterion 1 end to end (fixer lane V-UX-031-045, for lane V-FRW-037-054): given sealing
// succeeds, the sealed bytes are written write-once under the tenant (Versity S3 Gateway, Object
// Lock), an overwrite and a delete are refused while the retention lasts, and the hash of the bytes
// read back from the store is recorded in PostgreSQL (`workflow_sealed_pdf`) by
// `storeAndRecordSealedPdf`. The test makes its own database and its own Object Lock bucket, both
// named with V-UX-031-045, and removes them. Skipped when PostgreSQL or the S3 store is not up
// (infra/test-env.ps1 up). Test values only.
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { finaliseWorkflow, type SealResult } from '@docedit/authority';
import { createPool, ensureServiceRole, migrate, PgDocumentStore } from '../../src/index.ts';
import { S3ObjectStore } from '../../src/objects/s3.ts';
import { readSealedPdf, sealedHash, sealedPdfKey } from '../../src/objects/sealed-pdf.ts';
import { storeAndRecordSealedPdf } from '../../src/workflow/sealed-pdf-finalise.ts';
import { readSealedPdfRecord } from '../../src/workflow/sealed-pdf-pg.ts';
import { ObjectSealedPdfStore } from '../../src/workflow/sealed-store.ts';
import { ADMIN, newTenant, postgresUnavailable, SERVICE_USER, settings } from '../support/env.ts';

const S = settings();
const endpoint = `http://${S['DOCEDIT_S3_HOST']}:${S['DOCEDIT_S3_PORT']}`;
const region = S['DOCEDIT_S3_REGION'] ?? 'us-east-1';
const accessKeyId = S['DOCEDIT_S3_ACCESS_KEY'] ?? '';
const secretAccessKey = S['DOCEDIT_S3_SECRET_KEY'] ?? '';

const suffix = randomBytes(4).toString('hex');
const bucket = `docedit-v-ux-031-045-sealed-${suffix}`;
const objects = new S3ObjectStore({ endpoint, region, bucket, accessKeyId, secretAccessKey });
const absent = new S3ObjectStore({
  endpoint,
  region,
  bucket: `docedit-v-ux-031-045-absent-${suffix}`,
  accessKeyId,
  secretAccessKey,
});

async function s3Unavailable(): Promise<string | null> {
  try {
    await new S3ObjectStore({
      endpoint,
      region,
      bucket: 'docedit-probe',
      accessKeyId,
      secretAccessKey,
    }).exists('probe');
    return null;
  } catch (e) {
    return `the S3-compatible store is not reachable at ${endpoint} (${e instanceof Error ? e.message : String(e)})`;
  }
}

const unavailable = (await postgresUnavailable()) ?? (await s3Unavailable());
if (unavailable) console.warn(`skipped: ${unavailable}`);

const retainUntilMs = Date.now() + 6_000;
const written: string[] = [];
const pdf = (label: string) =>
  new TextEncoder().encode(`%PDF-1.7\n% V-UX-031-045 sealed sample ${label}\n%%EOF\n`);
const sealOf = (bytes: Uint8Array): SealResult => ({
  ok: true,
  timestamped: true,
  sealedHash: sealedHash(bytes),
});

describe.skipIf(unavailable !== null)('store and record a sealed PDF (FRW-054 criterion 1)', () => {
  const dbName = `docedit_t_v_ux_031_045_${suffix}`;
  let service: pg.Pool;
  let admin: pg.Pool;

  beforeAll(async () => {
    const password = S['DOCEDIT_PG_SERVICE_PASSWORD'] ?? '';
    const root = new pg.Client(ADMIN);
    await root.connect();
    try {
      await root.query("SELECT pg_advisory_lock(hashtext('docedit.test-roles'))");
      try {
        await ensureServiceRole(root, SERVICE_USER, password);
      } finally {
        await root.query("SELECT pg_advisory_unlock(hashtext('docedit.test-roles'))");
      }
      await root.query(`CREATE DATABASE ${dbName}`);
    } finally {
      await root.end();
    }
    admin = new pg.Pool({ ...ADMIN, database: dbName, max: 2 });
    admin.on('error', () => {});
    const c = await admin.connect();
    try {
      await migrate(c);
    } finally {
      c.release();
    }
    service = createPool({
      host: ADMIN.host,
      port: ADMIN.port,
      user: SERVICE_USER,
      password,
      database: dbName,
      max: 4,
    });
    await objects.createBucket({ objectLock: true });
  });

  afterAll(async () => {
    await service?.end().catch(() => {});
    await admin?.end().catch(() => {});
    const r = new pg.Client(ADMIN);
    await r.connect();
    try {
      await r.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    } finally {
      await r.end();
    }
    // Locked objects can be removed only once their retention has ended.
    const wait = retainUntilMs - Date.now() + 500;
    if (wait > 0) await new Promise((res) => setTimeout(res, wait));
    for (const key of written) await objects.delete(key).catch(() => undefined);
    await objects.deleteBucket().catch(() => undefined);
  });

  async function seedDocument(tenant: string): Promise<string> {
    const doc = await new PgDocumentStore(service).create(tenant, {
      cdmVersion: 1,
      createdBy: 'u',
    });
    return doc.id;
  }

  it('stores the sealed bytes write-once and records the hash of the bytes stored', async () => {
    const tenant = newTenant();
    const docId = await seedDocument(tenant);
    const workflowId = `wf-${randomUUID().slice(0, 8)}`;
    const bytes = pdf('one');
    const seal = sealOf(bytes);
    const key = sealedPdfKey(tenant, docId, workflowId);
    written.push(key);

    const out = await storeAndRecordSealedPdf(service, objects, {
      tenant,
      docId,
      workflowId,
      bytes,
      sealedHash: seal.ok ? seal.sealedHash : '',
      retainUntilMs,
    });
    expect(out.store).toEqual({ ok: true, storedHash: sealedHash(bytes) });

    // The bytes are in the store under the tenant, and cannot be overwritten or deleted.
    expect(key.startsWith(`tenants/${tenant}/`)).toBe(true);
    const back = await readSealedPdf(objects, tenant, docId, workflowId);
    expect(back).toEqual(bytes);
    const overwrite = await objects.put(key, pdf('rewritten')).catch((e: unknown) => e);
    expect((overwrite as { status?: number }).status).toBe(403);
    const removal = await objects.delete(key).catch((e: unknown) => e);
    expect((removal as { status?: number }).status).toBe(403);
    expect(await readSealedPdf(objects, tenant, docId, workflowId)).toEqual(bytes);

    // The hash is recorded in PostgreSQL: the hash of the original bytes and of the bytes read back.
    const record = await readSealedPdfRecord(service, tenant, docId, workflowId);
    expect(record).toEqual(out.record);
    expect(record?.sealedHash).toBe(sealedHash(bytes));
    expect(record?.storedHash).toBe(sealedHash(back ?? new Uint8Array()));
    expect(record?.objectKey).toBe(key);
    expect(record?.retainUntilMs).toBe(retainUntilMs);

    const outcome = finaliseWorkflow({ compile: { ok: true }, seal, store: out.store });
    expect(outcome.status).toBe('finalised');
  });

  it('records nothing and keeps the workflow at completed when the store fails', async () => {
    const tenant = newTenant();
    const docId = await seedDocument(tenant);
    const bytes = pdf('absent');
    const out = await storeAndRecordSealedPdf(service, absent, {
      tenant,
      docId,
      workflowId: 'wf-absent',
      bytes,
      sealedHash: sealedHash(bytes),
      retainUntilMs,
    });
    expect(out).toEqual({ store: { ok: false, reason: 'store_failed' }, record: null });
    expect(await readSealedPdfRecord(service, tenant, docId, 'wf-absent')).toBeNull();
    const outcome = finaliseWorkflow({
      compile: { ok: true },
      seal: sealOf(bytes),
      store: out.store,
    });
    expect(outcome.status).toBe('completed');
  });

  it('records nothing when the stored bytes do not match the sealed hash', async () => {
    const tenant = newTenant();
    const docId = await seedDocument(tenant);
    const bytes = pdf('mismatch');
    written.push(sealedPdfKey(tenant, docId, 'wf-mismatch'));
    const claimed = sealedHash(pdf('other'));
    const out = await storeAndRecordSealedPdf(service, objects, {
      tenant,
      docId,
      workflowId: 'wf-mismatch',
      bytes,
      sealedHash: claimed,
      retainUntilMs,
    });
    expect(out).toEqual({ store: { ok: true, storedHash: sealedHash(bytes) }, record: null });
    expect(await readSealedPdfRecord(service, tenant, docId, 'wf-mismatch')).toBeNull();
    const outcome = finaliseWorkflow({
      compile: { ok: true },
      seal: { ok: true, timestamped: true, sealedHash: claimed },
      store: out.store,
    });
    expect(outcome.status).toBe('completed');
    expect(outcome.stoppedAt).toBe('store');
  });

  it('reports store_failed, so the workflow stays completed, when the hash cannot be recorded', async () => {
    const tenant = newTenant();
    const docId = randomUUID(); // no such document: the record's foreign key refuses it
    const bytes = pdf('unrecorded');
    written.push(sealedPdfKey(tenant, docId, 'wf-unrecorded'));
    const out = await storeAndRecordSealedPdf(service, objects, {
      tenant,
      docId,
      workflowId: 'wf-unrecorded',
      bytes,
      sealedHash: sealedHash(bytes),
      retainUntilMs,
    });
    expect(out).toEqual({ store: { ok: false, reason: 'store_failed' }, record: null });
    const outcome = finaliseWorkflow({
      compile: { ok: true },
      seal: sealOf(bytes),
      store: out.store,
    });
    expect(outcome.status).toBe('completed');
  });

  it('reads the stored PDF and its record back through the sealed store (FRW-054 criterion 4)', async () => {
    const tenant = newTenant();
    const docId = await seedDocument(tenant);
    const workflowId = `wf-${randomUUID().slice(0, 8)}`;
    written.push(sealedPdfKey(tenant, docId, workflowId));
    const sealedStore = new ObjectSealedPdfStore(service, objects);
    expect(await sealedStore.read(tenant, docId, workflowId)).toBeNull();
    const bytes = pdf('read-through');
    const out = await sealedStore.store({
      tenant,
      docId,
      workflowId,
      bytes,
      sealedHash: sealedHash(bytes),
      retainUntilMs,
    });
    expect(out.store).toEqual({ ok: true, storedHash: sealedHash(bytes) });
    const read = await sealedStore.read(tenant, docId, workflowId);
    expect(read?.bytes).toEqual(bytes);
    expect(read?.record.storedHash).toBe(sealedHash(bytes));
    // A second store for the workflow is refused and the first bytes stay.
    const other = pdf('replacement');
    const second = await sealedStore.store({
      tenant,
      docId,
      workflowId,
      bytes: other,
      sealedHash: sealedHash(other),
      retainUntilMs,
    });
    expect(second.store).toEqual({ ok: false, reason: 'store_failed' });
    expect((await sealedStore.read(tenant, docId, workflowId))?.bytes).toEqual(bytes);
  });
});
