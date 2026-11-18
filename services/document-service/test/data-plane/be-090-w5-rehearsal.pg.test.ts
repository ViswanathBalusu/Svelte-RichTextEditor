/**
 * BE-090 criterion 5 (lane w5): the written repair procedure
 * (`services/document-service/docs/repair-procedure.md`) is rehearsed on a deliberately damaged
 * document, step by step, on PostgreSQL (the log and the audit trail) and the S3-compatible store
 * (the checkpoints), both in Podman, with the outbox delivered into the running room. The rehearsal is
 * run by this test, which does what each numbered step of the document says and writes a record of
 * every step to `test/postgres/rehearsals/be-090-repair.json` (the form SEC-048 uses). It is not an
 * operator at a terminal; the record says so.
 *
 * The damage: a checkpoint at seq 2 holds the content of seq 0, so a node that opens the document
 * starts from content that lacks two edits the log has, one of them in an approved region. The
 * rehearsal first meets the room's refusal of that region, changes the region's state, and then the
 * repair succeeds. The file skips, with the reason, when PostgreSQL or the object store is not up:
 * pwsh -NoProfile -File infra/test-env.ps1 up
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { ObjectCheckpointStore } from '../../src/objects/checkpoints.ts';
import { S3ObjectStore } from '../../src/objects/s3.ts';
import { MemoryOutbox } from '../../src/data-plane/memory-ports.ts';
import { Metrics } from '../../src/data-plane/metrics.ts';
import { OutboxDelivery } from '../../src/data-plane/outbox.ts';
import { PgAuditStore } from '../../src/data-plane/pg/audit.ts';
import { enqueueRepair, planRepair } from '../../src/data-plane/repair.ts';
import { rebuild, verifyCheckpoint, type RecoveryStores } from '../../src/data-plane/recovery.ts';
import { settingsFrom } from '../../src/data-plane/settings.ts';
import { Tracer } from '../../src/data-plane/tracing.ts';
import {
  pgStores,
  createTestDatabase,
  postgresUnavailable,
  settings,
  type TestDatabase,
} from '../support/env.ts';
import { insertText } from './client.ts';
import { startPlane, type Plane } from './support.ts';

const PROCEDURE = fileURLToPath(new URL('../../docs/repair-procedure.md', import.meta.url));
const RECORD = fileURLToPath(new URL('../postgres/rehearsals/be-090-repair.json', import.meta.url));
const TERMS_ID = 'rTerms000000000A';

/** The position inside the first text block of a region of the fixture document. */
function insideRegion(rid: string): number {
  let inside = -1;
  baseDoc().descendants((node, pos) => {
    if (inside >= 0) return false;
    if (node.type.name === 'region' && node.attrs['id'] === rid) {
      node.descendants((child, cpos) => {
        if (inside < 0 && child.isTextblock) inside = pos + 1 + cpos + 1;
        return inside < 0;
      });
      return false;
    }
    return true;
  });
  if (inside < 0) throw new Error(`no text block in region ${rid}`);
  return inside;
}

const S = settings();
const s3Settings = {
  endpoint: `http://${S['DOCEDIT_S3_HOST']}:${S['DOCEDIT_S3_PORT']}`,
  region: S['DOCEDIT_S3_REGION'] ?? 'us-east-1',
  bucket: S['DOCEDIT_S3_BUCKET'] ?? 'docedit-test',
  accessKeyId: S['DOCEDIT_S3_ACCESS_KEY'] ?? '',
  secretAccessKey: S['DOCEDIT_S3_SECRET_KEY'] ?? '',
};

async function s3Unavailable(): Promise<string | null> {
  try {
    await new S3ObjectStore(s3Settings).exists(`probe/${randomUUID()}`);
    return null;
  } catch (e) {
    return `the S3-compatible store is not reachable (${e instanceof Error ? e.message : String(e)})`;
  }
}

const unavailable = (await postgresUnavailable()) ?? (await s3Unavailable());
if (unavailable) console.warn(`skipped: ${unavailable}`);

interface Step {
  /** The step of the document: `before` or its number. */
  step: string;
  /** The heading text of the step, as the document words it. */
  says: string;
  ok: boolean;
  detail: string;
  at: string;
}

/** The numbered steps of the procedure, as the document writes them. */
function stepsOfDocument(): string[] {
  const text = readFileSync(PROCEDURE, 'utf8');
  const section = text.split(/^## Steps$/m)[1]?.split(/^## /m)[0] ?? '';
  return [...section.matchAll(/^(\d+)\. (.+)$/gm)].map((m) => `${m[1]}. ${m[2]}`);
}

describe.skipIf(unavailable !== null)(
  'the repair procedure is rehearsed on a damaged document (BE-090 criterion 5)',
  () => {
    let db: TestDatabase;
    const planes: Plane[] = [];
    const tenants: string[] = [];
    const objects = new ObjectCheckpointStore(new S3ObjectStore(s3Settings));

    beforeAll(async () => {
      db = await createTestDatabase();
    });

    afterAll(async () => {
      for (const p of planes) await p.close().catch(() => {});
      const store = new S3ObjectStore(s3Settings);
      for (const t of tenants)
        for (const key of await store.list(`tenants/${t}/`)) await store.delete(key);
      await db?.drop();
    });

    it('follows each numbered step of the document, meets the refusal of an approved region, and succeeds', async () => {
      const doc = stepsOfDocument();
      expect(doc).toHaveLength(6);
      const steps: Step[] = [];
      const record = (step: string, says: string, ok: boolean, detail: string): void => {
        steps.push({ step, says, ok, detail, at: new Date().toISOString() });
        expect(ok, `${step}: ${detail}`).toBe(true);
      };

      // The damaged test document: two edits by a first node, then a checkpoint at seq 2 that holds
      // the content of seq 0 (the log does not produce it).
      const s = pgStores(db.service);
      const stores = { logs: s.logs, ownership: s.logs, grants: s.grants, documents: s.docs };
      const recovery: RecoveryStores = { logs: s.logs, checkpoints: objects };
      const first = await startPlane({ stores, deps: { checkpoints: objects } });
      planes.push(first);
      tenants.push(first.tenant);
      const docId = await first.createDocument();
      const ref = first.ref(docId);
      await objects.put(ref, 0, (await first.checkpoints.get(ref, 0))!);
      const alice = await first.client('alice', { [docId]: 'owner' });
      await alice.open(1, docId);
      const edits = [
        insertText(insideRegion(TERMS_ID), 'terms edit'),
        insertText(posInside(baseDoc(), 'pIntro0000000001'), 'intro edit'),
      ];
      for (let i = 0; i < edits.length; i++)
        expect((await alice.submit(1, { base: i, steps: [edits[i]!] })).t).toBe('sync.ack');
      await first.close();
      await objects.put(ref, 2, (await objects.get(ref, 0))!);

      // A node that opens the document now starts from the damaged checkpoint; the Terms region is approved.
      const second = await startPlane({
        stores,
        tenant: first.tenant,
        deps: { checkpoints: objects },
      });
      planes.push(second);
      const owner = await second.client('alice', { [docId]: 'owner' });
      await owner.open(1, docId);
      await second.changeGrants(docId, {
        setRegionStates: [{ region: TERMS_ID, state: 'approved' }],
      });
      await owner.take((m) => m.t === 'perm.changed');

      // Before you start: recovery names the damaged checkpoint (BE-081); the operator, the document
      // and the reason are noted; the approved region is known.
      const verdict = await verifyCheckpoint(recovery, ref, 2);
      record(
        'before',
        'Confirm the damage with the recovery procedure',
        !verdict.ok,
        'verifyCheckpoint names the checkpoint at seq 2 as different from its replay',
      );
      const audit = new PgAuditStore(db.service);
      const outbox = new MemoryOutbox(() => Date.now());
      const delivery = new OutboxDelivery({
        store: outbox,
        host: second.plane.host,
        node: 'node-w5-rehearsal',
        settings: settingsFrom({
          onError: (e) => second.errors.push(e),
          outbox: { pollMs: 60_000, leaseMs: 1_000, batch: 20 },
        }),
        metrics: new Metrics('node-w5-rehearsal'),
        tracer: new Tracer(undefined),
      });
      const operator = 'operator-w5-rehearsal';
      const headBefore = (await s.logs.head(ref)).seq;

      // Step 1: dry run. Nothing is stored.
      const plan = await planRepair(recovery, ref, { operator, reason: 'damaged checkpoint 2' });
      record(
        '1',
        doc[0]!,
        plan.head === headBefore &&
          plan.from === 0 &&
          (await s.logs.head(ref)).seq === headBefore &&
          (await outbox.claim('node-dry', 1_000, 10)).length === 0,
        `the plan names head ${plan.head}, checkpoint ${plan.from}, hash now ${plan.currentHash.slice(0, 12)}, hash after ${plan.targetHash.slice(0, 12)}; the log and the outbox are as they were`,
      );

      // Step 2: read the plan. The document is broken at its head.
      record('2', doc[1]!, plan.changes, 'changes is true: the content at the head differs');

      // Step 3 and 4: enqueue; the room applies it, and refuses it while the Terms region is approved.
      const refusedItem = await enqueueRepair({ plan, outbox, audit });
      await delivery.poll();
      const refused = await outbox.get(ref.tenant, refusedItem.id);
      record(
        '3',
        doc[2]!,
        refusedItem.state === 'pending' && refusedItem.kind === 'snapshot',
        'one outbox item of kind snapshot with reason repair, and the audit event repair.enqueued',
      );
      record(
        '4',
        doc[3]!,
        refused?.state === 'failed' &&
          refused.result?.['code'] === 'forbidden' &&
          String(refused.result?.['message']).includes(TERMS_ID) &&
          (await s.logs.head(ref)).seq === headBefore,
        `the item settled failed with the room's rejection (forbidden, region ${TERMS_ID}); the log did not move. An item that fails is not retried by hand without a new plan`,
      );

      // The region's state is changed (PRM-046, PRM-047), then a new plan, item and delivery.
      await second.changeGrants(docId, {
        setRegionStates: [{ region: TERMS_ID, state: 'in_review' }],
      });
      await owner.take((m) => m.t === 'perm.changed' && m.d!['rev'] !== undefined);
      const head = (await s.logs.head(ref)).seq;
      const again = await planRepair(recovery, ref, { operator, reason: 'damaged checkpoint 2' });
      const item = await enqueueRepair({ plan: again, outbox, audit });
      await delivery.poll();
      const done = await outbox.get(ref.tenant, item.id);
      const [commit] = await s.logs.read(ref, head + 1, head + 1);
      record(
        '4',
        `${doc[3]!} (after the region left approved)`,
        done?.state === 'done' &&
          done.result?.['seq'] === head + 1 &&
          commit?.origin === 'repair' &&
          commit.user === 'system',
        `the item settled done with seq ${head + 1}, the head plus one; the commit has origin repair and user system`,
      );

      // Step 5: the chain verifies, the content hashes to the plan's target, the audit event is there.
      const chain = await s.logs.verify(ref);
      const content = (await rebuild(recovery, ref)).hash;
      const events = (await audit.query(ref.tenant, { doc: docId, limit: 100 })).filter(
        (e) => e.kind === 'repair.enqueued',
      );
      record(
        '5',
        doc[4]!,
        chain.ok &&
          content === again.targetHash &&
          events.length === 2 &&
          events.every((e) => e.actor === operator && e.doc === docId),
        'the chain of the log verifies; the content at the new head hashes to the target of the plan; the audit trail holds repair.enqueued for both plans with the operator and the document',
      );

      // Step 6: the damaged checkpoint is left as it is.
      record(
        '6',
        doc[5]!,
        (await objects.get(ref, 2)) !== null,
        'the checkpoint at seq 2 is still stored, as the incident record would say',
      );

      const version = await db.admin.query('SHOW server_version');
      const out = {
        procedure: 'BE-090 repair of a broken document with an audited commit',
        document: 'services/document-service/docs/repair-procedure.md',
        runBy:
          'this test, following the numbered steps of the document; not an operator at a terminal',
        engine: `PostgreSQL ${String(version.rows[0]?.['server_version'] ?? 'unknown')}`,
        database: db.name,
        where:
          'PostgreSQL and the S3-compatible store in Podman, the shared test environment (infra/test-env.ps1), 127.0.0.1',
        started: steps[0]?.at ?? null,
        steps,
        allPassed: steps.every((x) => x.ok),
      };
      mkdirSync(fileURLToPath(new URL('../postgres/rehearsals/', import.meta.url)), {
        recursive: true,
      });
      writeFileSync(RECORD, JSON.stringify(out, null, 2) + '\n', 'utf8');
      expect(out.allPassed).toBe(true);
      expect(second.errors).toEqual([]);
    }, 120_000);
  },
);
