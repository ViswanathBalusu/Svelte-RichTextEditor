/**
 * SEC-044 on PostgreSQL (lane w8): evidence stays out of the commit log and everything else.
 *
 * The evidence of a signing is recorded through the product path, `PgCaptureSettingsStore.recordEvidence`
 * (services/document-service/src/workflow/capture-settings-pg.ts), beside a real commit log. The
 * evidence carries one canary for each class the story names: an IP address, a user agent, an `amr`
 * value, a consent text and a signature image. Then every base table of the database is searched as
 * text, by the admin role, which sees every row, so the commit log, its metadata, the audit trail
 * and any search entries are covered by the same scan:
 *
 * - with capture on, each canary is in `workflow_evidence` and in no other table;
 * - with capture off for the tenant (changed through the store, which audits the change), the IP
 *   address and user agent of a later event are in no table at all, and the other items are kept;
 * - after the retention period the evidence rows are purged, no canary is left in any table, and
 *   the hash chain of the log verifies as it did before.
 *
 * Not shown: there is no participant endpoint that signs and no workflow that completes, so the
 * facts are given to `recordEvidence` directly (SEC-044 criteria 1 and 3 name a completed workflow
 * and a participant who signs); no control commit carries an evidence commitment yet, so "only salted
 * hashes appear in the chain" has nothing to read; logs and metrics are not scanned here
 * (SEC-047 does that for the service's own output). Each run makes its own database and drops it.
 * Skipped when PostgreSQL is not up (infra/test-env.ps1 up).
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runEvidencePurge } from '@docedit/authority';
import {
  createPool,
  ensureServiceRole,
  migrate,
} from '../../../services/document-service/src/index.ts';
import { inTenant } from '../../../services/document-service/src/storage/db.ts';
import {
  PgEvidenceRowStore,
  PgPurgeAuditSink,
} from '../../../services/document-service/src/workflow/evidence-store.ts';
import { PgCaptureSettingsStore } from '../../../services/document-service/src/workflow/capture-settings-pg.ts';
import {
  ADMIN,
  newTenant,
  pgStores,
  postgresUnavailable,
  SERVICE_USER,
  settings,
} from '../../../services/document-service/test/support/env.ts';
import {
  newDocument,
  stepCommit,
  write,
  type StoreHarness,
} from '../../../services/document-service/test/contract/checks.ts';

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

const DAY = 86_400_000;

describe.skipIf(unavailable !== null)(
  'SEC-044: evidence stays outside the log (PostgreSQL)',
  () => {
    const suffix = randomBytes(4).toString('hex');
    const dbName = `docedit_t_w8_sec044_${suffix}`;
    const canary = {
      ip: `198.51.100.${(parseInt(suffix.slice(0, 2), 16) % 200) + 20}-IPCANARY${suffix}`,
      ua: `UserAgentCanary/${suffix}`,
      amr: `amr-canary-${suffix}`,
      consent: `ConsentTextCanary ${suffix} I agree to sign electronically`,
      image: `data:image/png;base64,SIGNATURECANARY${suffix}`,
    };
    const lateCanary = {
      ip: `203.0.113.${(parseInt(suffix.slice(2, 4), 16) % 200) + 20}-LATEIPCANARY${suffix}`,
      ua: `LateUserAgentCanary/${suffix}`,
      amr: `late-amr-canary-${suffix}`,
    };
    let service: pg.Pool;
    let admin: pg.Pool;

    beforeAll(async () => {
      if (unavailable) return;
      const password = settings()['DOCEDIT_PG_SERVICE_PASSWORD'] ?? '';
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
    });

    afterAll(async () => {
      await service?.end().catch(() => {});
      await admin?.end().catch(() => {});
      if (unavailable) return;
      const r = new pg.Client(ADMIN);
      await r.connect();
      try {
        await r.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      } finally {
        await r.end();
      }
    });

    /** The base tables whose rows, read as text, hold `needle`. */
    async function holders(needle: string): Promise<string[]> {
      const tables = await admin.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
      );
      expect(tables.rows.length).toBeGreaterThan(1);
      const out: string[] = [];
      for (const { table_name } of tables.rows) {
        const hit = await admin.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM "${table_name}" AS x WHERE x::text LIKE $1`,
          [`%${needle}%`],
        );
        if ((hit.rows[0]?.n ?? 0) > 0) out.push(table_name);
      }
      return out;
    }

    it('keeps each class of evidence out of the log, the audit trail and every other table, and survives the purge', async () => {
      const tenant = newTenant();
      const s = pgStores(service);
      const h: StoreHarness = {
        tenant,
        otherTenant: newTenant(),
        docs: s.docs,
        logs: s.logs,
        grants: s.grants,
      };
      const { ref, epoch } = await newDocument(h);
      expect(
        await s.logs.append(ref, write(epoch, [stepCommit(1), stepCommit(2), stepCommit(3)])),
      ).toEqual({
        status: 'ok',
      });
      const chainBefore = await s.logs.verify(ref);
      expect(chainBefore).toEqual({ ok: true, head: 3 });

      let clock = Date.now() - 10 * DAY;
      const store = new PgCaptureSettingsStore(service, { now: () => clock });

      // Capture is on by default: the signing is recorded with every class of evidence.
      await store.recordEvidence(tenant, {
        doc: ref.doc,
        participant: 'p1',
        item: 'signed',
        facts: {
          items: {
            amr: [canary.amr],
            consentText: canary.consent,
            signatureImage: canary.image,
          },
          ipAddress: canary.ip,
          userAgent: canary.ua,
        },
      });
      for (const [name, value] of Object.entries(canary)) {
        expect(await holders(value), `${name} with capture on`).toEqual(['workflow_evidence']);
      }

      // The tenant switches capture off (audited by the store); a later signing is recorded again.
      clock += 1_000;
      const changed = await store.change(tenant, 'admin-surrogate-w8', {
        captureNetworkIdentity: false,
      });
      expect(changed.audit).not.toBeNull();
      clock += 1_000;
      await store.recordEvidence(tenant, {
        doc: ref.doc,
        participant: 'p2',
        item: 'signed',
        facts: {
          items: { amr: [lateCanary.amr] },
          ipAddress: lateCanary.ip,
          userAgent: lateCanary.ua,
        },
      });
      // The network identity of the later event is in no table at all, the audit trail included.
      expect(await holders(lateCanary.ip), 'IP address with capture off').toEqual([]);
      expect(await holders(lateCanary.ua), 'user agent with capture off').toEqual([]);
      // The other items are still kept, in the evidence table only.
      expect(await holders(lateCanary.amr)).toEqual(['workflow_evidence']);
      // The audit entry of the change names the actor and the two values, and no evidence.
      expect(await holders('admin-surrogate-w8')).toContain('audit_events');

      // The retention ends: the rows go, and no canary is left in any table; the chain verifies.
      const result = await runEvidencePurge(
        new PgEvidenceRowStore(service, tenant),
        new PgPurgeAuditSink(service, tenant),
        { documentId: ref.doc, nowMs: Date.now(), retentionMs: 1_000, legalHold: false },
      );
      expect(result.removed.length).toBe(2);
      for (const value of [...Object.values(canary), ...Object.values(lateCanary)])
        expect(await holders(value), `${value} after the purge`).toEqual([]);
      expect(await s.logs.verify(ref)).toEqual(chainBefore);

      // The purge's own audit entry holds counts, not evidence.
      const audit = await inTenant(
        service,
        tenant,
        (c) => c.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_events`),
        { readOnly: true },
      );
      expect(audit.rows[0]!.n).toBeGreaterThan(0);
    });
  },
);
