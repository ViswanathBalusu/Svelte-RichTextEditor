/**
 * BE-090 criteria 1, 3 and 4 against PostgreSQL (the log and the audit trail) and the S3-compatible
 * store (the checkpoints), with the outbox delivered into the running room (BE-039). A document is
 * damaged on purpose: a checkpoint is written with content that its log does not produce, so BE-081
 * shows it broken. The repair is planned (a dry run), enqueued as a server-authored snapshot with
 * origin `repair`, applied by the room, and the chain and the content are checked afterwards.
 * Criterion 2 (an approved region refuses a repair) and criterion 5 (an operator rehearsal of the
 * written procedure) are not covered here. The file skips, with the reason, when PostgreSQL or the
 * object store is not up: pwsh -NoProfile -File infra/test-env.ps1 up
 */
import { randomUUID } from 'node:crypto';
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

const intro = () => posInside(baseDoc(), 'pIntro0000000001');
const WORDS = ['Repair alpha', 'Repair beta', 'Repair gamma'];

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

describe.skipIf(unavailable !== null)(
  'the repair of a broken document through the outbox (BE-090 criteria 1, 3 and 4)',
  () => {
    let db: TestDatabase;
    let plane: Plane | undefined;
    const tenants: string[] = [];
    const objects = new ObjectCheckpointStore(new S3ObjectStore(s3Settings));

    beforeAll(async () => {
      db = await createTestDatabase();
    });

    afterAll(async () => {
      await plane?.close().catch(() => {});
      const store = new S3ObjectStore(s3Settings);
      for (const t of tenants)
        for (const key of await store.list(`tenants/${t}/`)) await store.delete(key);
      await db?.drop();
    });

    it('a document that BE-081 shows broken is repaired by a dry run, then one server-authored commit with origin repair', async () => {
      const s = pgStores(db.service);
      const stores: RecoveryStores = { logs: s.logs, checkpoints: objects };
      plane = await startPlane({
        stores: { logs: s.logs, ownership: s.logs, grants: s.grants, documents: s.docs },
        deps: { checkpoints: objects },
      });
      tenants.push(plane.tenant);
      const doc = await plane.createDocument();
      const ref = plane.ref(doc);
      await objects.put(ref, 0, (await plane.checkpoints.get(ref, 0))!);
      const alice = await plane.client('alice', { [doc]: 'owner' });
      await alice.open(1, doc);
      for (let i = 0; i < WORDS.length; i++) {
        const r = await alice.submit(1, { base: i, steps: [insertText(intro(), WORDS[i]!)] });
        expect(r.t).toBe('sync.ack');
      }

      // The damage: a checkpoint at seq 2 holding the content of seq 0, which the log does not produce.
      await objects.put(ref, 2, (await objects.get(ref, 0))!);
      expect((await verifyCheckpoint(stores, ref, 2)).ok).toBe(false);

      // Criterion 4: the dry run shows the change and stores nothing.
      const outbox = new MemoryOutbox(() => Date.now());
      const plan = await planRepair(stores, ref, {
        operator: 'operator-u-be-085-098',
        reason: 'damaged checkpoint 2',
      });
      expect(plan).toMatchObject({ head: 3, from: 0, changes: true });
      expect(plan.currentHash).not.toBe(plan.targetHash);
      expect((await s.logs.head(ref)).seq).toBe(3);
      expect(await outbox.claim('node-dry', 1_000, 10)).toEqual([]);

      // The repair: an item for the outbox, and the audit event that names the operator, the document
      // and the reason.
      const audit = new PgAuditStore(db.service);
      const item = await enqueueRepair({ plan, outbox, audit });
      expect(item).toMatchObject({ kind: 'snapshot', state: 'pending' });

      const d = new OutboxDelivery({
        store: outbox,
        host: plane.plane.host,
        node: 'node-a',
        settings: settingsFrom({
          onError: (e) => plane!.errors.push(e),
          outbox: { pollMs: 60_000, leaseMs: 1_000, batch: 20 },
        }),
        metrics: new Metrics('node-a'),
        tracer: new Tracer(undefined),
      });
      await d.poll();
      expect(await outbox.get(ref.tenant, item.id)).toMatchObject({
        state: 'done',
        result: { seq: 4 },
      });

      // Criterion 1: the commit at 4 is server-authored with origin repair, and the document's content is
      // the content the plan named.
      const [commit] = await s.logs.read(ref, 4, 4);
      expect(commit).toMatchObject({ seq: 4, origin: 'repair', user: 'system' });
      expect((await rebuild(stores, ref)).hash).toBe(plan.targetHash);

      // Criterion 3: the chain links are unbroken after the repair, and the audit trail names the
      // operator, the document and the reason.
      expect((await s.logs.verify(ref)).ok).toBe(true);
      const events = (await audit.query(ref.tenant, { doc: ref.doc, limit: 100 })).filter(
        (e) => e.kind === 'repair.enqueued',
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actor: 'operator-u-be-085-098',
        doc: ref.doc,
        data: { reason: 'damaged checkpoint 2', head: 3, from: 0, targetHash: plan.targetHash },
      });
      expect(plane.errors).toEqual([]);
    });

    it('a dry run on a sound document reports no change, and enqueueRepair refuses to write one', async () => {
      const s = pgStores(db.service);
      const stores: RecoveryStores = { logs: s.logs, checkpoints: objects };
      const doc = await plane!.createDocument();
      const ref = plane!.ref(doc);
      await objects.put(ref, 0, (await plane!.checkpoints.get(ref, 0))!);
      const plan = await planRepair(stores, ref, {
        operator: 'operator-u-be-085-098',
        reason: 'check only',
      });
      expect(plan).toMatchObject({ head: 0, changes: false });
      await expect(
        enqueueRepair({
          plan,
          outbox: new MemoryOutbox(() => 0),
          audit: new PgAuditStore(db.service),
        }),
      ).rejects.toThrow(/would change nothing/);
    });
  },
);
