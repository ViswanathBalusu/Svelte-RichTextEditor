// HIS-039 (lane w7, 2026-11-17): the purge of a deleted document on PostgreSQL, through the service.
//
// Documents are created and deleted through the REST routes (`DELETE /documents/{id}` is the soft
// delete that raises `dep.document.deleted`), and the log, the grants, a read marker, jobs, assets
// and objects are written as the service writes them. The purge then runs as the job does
// (`DocumentPurge`, `PgPurgeStore`) over a pool whose connections `SET ROLE docedit_purge`, the role
// of migration 0073, so the test also shows that the role's grants are enough and no more.
//
// Criteria covered: 1 (every store), 2 (a shared asset is kept), 4 (`not_found` afterwards), 5 (a
// document under a legal hold is not purged) and 6 (audited; the webhook event was raised at delete
// time and not again). Criterion 3 (the backup schedule) is a document for the operator, not code.
// The database is made for this file and dropped afterwards. Test values only.
import { createHash, randomUUID } from 'node:crypto';
import { uuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SearchIndex } from '../../src/control-plane/search-index.ts';
import { DAY_MS, DocumentPurge } from '../../src/control-plane/document-purge.ts';
import { PgPurgeStore } from '../../src/control-plane/document-purge-pg.ts';
import { inTenant } from '../../src/storage/db.ts';
import { ADMIN } from '../support/env.ts';
import { objectKeys } from '../../src/objects/store.ts';
import type { DocRef } from '../../src/storage/types.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
} from '../control-plane/support.ts';

const skip = await skipReason('postgres');
if (skip) console.warn(`skipped: ${skip}`);

const bytes = (s: string) => new TextEncoder().encode(s);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe.skipIf(skip !== null)('purging a deleted document (HIS-039, PostgreSQL)', () => {
  let h: Harness;
  let purgePool: pg.Pool;
  let purge: DocumentPurge;
  // The search entries of the purge. The service has no search tables in its migrations yet, so the
  // index is the memory one (the PostgreSQL one has the same purgeDocument).
  const searchIndex = new SearchIndex();
  let owner: (doc: string) => string;
  const tables: string[] = [];

  beforeAll(async () => {
    h = await startHarness('postgres', {});
    // The purge role: the admin login, with every connection set to docedit_purge.
    purgePool = new pg.Pool({ ...ADMIN, database: h.db!.name, max: 3 });
    purgePool.on('error', () => {});
    purgePool.on('connect', (c) => {
      void c.query('SET ROLE docedit_purge');
    });
    purge = new DocumentPurge({
      store: new PgPurgeStore(purgePool),
      objects: h.parts.objects,
      audit: h.parts.audit!,
      search: searchIndex,
      retentionMs: 30 * DAY_MS,
      now: () => Date.now(),
    });
    owner = (doc) => h.userToken({ [doc]: 'owner' }, { sub: 'olga' });
    const t = await h.db!.admin.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
    );
    tables.push(...t.rows.map((r) => r.table_name));
  }, 60_000);
  afterAll(async () => {
    await purgePool?.end();
    await h?.close();
  });

  const ref = (doc: string): DocRef => ({ tenant: h.tenant, doc });

  async function newDoc(title: string): Promise<string> {
    return h.createDocument({ content: documentWithRegions(), title });
  }

  /** One typing commit, appended as a room would. */
  async function commit(doc: string): Promise<void> {
    const root = cdmSchema().nodeFromJSON(
      (await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey })).json.doc,
    );
    let pos = -1;
    root.descendants((n, p) => {
      if (pos < 0 && n.isTextblock) pos = p + 1;
      return pos < 0;
    });
    const r = ref(doc);
    const epoch = await h.parts.ownership.claim(r, 'test-node');
    const head = await h.parts.logs.head(r);
    const perms = await h.parts.grants.current(r);
    const res = await h.parts.logs.append(r, {
      epoch,
      revision: perms.revision,
      fromSeq: head.seq + 1,
      commits: [
        {
          seq: head.seq + 1,
          id: uuid7(),
          kind: 'steps' as const,
          steps: [
            {
              stepType: 'replace',
              from: pos,
              to: pos,
              slice: { content: [{ type: 'text', text: 'x' }] },
            },
          ] as never,
          user: (await h.parts.users.resolve(h.tenant, 'bob')).surrogate,
          session: 's',
          time: h.now(),
          origin: 'input',
          scopes: ['body'],
          revision: perms.revision,
          cdm: 1,
          engine: 'pm-steps/1',
          retired: [],
          claimed: [],
        },
      ],
    });
    if (res.status !== 'ok') throw new Error(`append refused: ${res.status}`);
  }

  async function sql<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ) {
    return inTenant(h.db!.service, h.tenant, async (c) => (await c.query<T>(text, values)).rows);
  }

  async function asset(
    doc: string,
    id: string,
    content: string,
    attachTo: string[],
  ): Promise<string> {
    const hash = sha(content);
    const key = objectKeys.asset(h.tenant, hash);
    await h.parts.objects.put(key, bytes(content));
    await h.db!.admin.query(
      `INSERT INTO assets (id, tenant_id, doc_id, mime, declared_bytes, state, sha256, bytes, content_type,
                           object_key, created_by, created_at, upload_expires_at)
       VALUES ($1, $2, $3, 'image/png', 4, 'ready', decode($4, 'hex'), 4, 'image/png', $5, 'x', now(), now())`,
      [id, h.tenant, doc, hash, key],
    );
    for (const d of attachTo)
      await h.db!.admin.query(
        'INSERT INTO doc_assets (tenant_id, doc_id, asset_id, first_seq) VALUES ($1, $2, $3, 0)',
        [h.tenant, d, id],
      );
    return key;
  }

  /** Every table whose rows mention the identifier, by the text of the row (the audit trail excepted by the caller). */
  async function tablesMentioning(id: string): Promise<string[]> {
    const out: string[] = [];
    for (const t of tables) {
      const r = await h.db!.admin.query<{ n: string }>(
        `SELECT count(*) AS n FROM "${t}" x WHERE to_jsonb(x)::text LIKE $1`,
        [`%${id}%`],
      );
      if (Number(r.rows[0]!.n) > 0) out.push(t.replace(/^audit_events_.*/, 'audit_events'));
    }
    return [...new Set(out)];
  }

  it('purges every store of a document past its retention, keeps a shared asset, and audits it', async () => {
    const d = await newDoc('Purged');
    const e = await newDoc('Kept');
    await commit(d);
    await commit(d);
    await commit(e);

    // Rows of the other stores: a grant, a read marker, a job with its export, objects of the
    // document, and three assets (own, shared with E, own with content that E's asset shares).
    const bob = (await h.parts.users.resolve(h.tenant, 'bob')).surrogate;
    await h.parts.grants.change(
      ref(d),
      {
        putGrants: [
          { region: 'rLegal0000000001', principal: `user:${bob}`, role: 'editor', expiresAt: null },
        ],
      },
      { actor: 'system' },
    );
    await h.parts.readMarkers!.advance(ref(d), bob, 2, Date.now());
    const job = randomUUID();
    await h.db!.admin.query(
      `INSERT INTO jobs (id, tenant_id, doc_id, kind, state, payload, attempts, max_attempts, run_after, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, 'export', 'completed', '{}'::jsonb, 1, 3, now(), $4, now(), now())`,
      [job, h.tenant, d, bob],
    );
    const keysOfD = [
      objectKeys.checkpoint(h.tenant, d, 2),
      objectKeys.segment(h.tenant, d, 1, 2),
      objectKeys.exportFile(h.tenant, job, 'out.pdf'),
    ];
    for (const k of keysOfD) await h.parts.objects.put(k, bytes('d'));
    // A checkpoint row (with its object above), and the search entries of both documents.
    await h.parts.checkpointIndex!.record(ref(d), {
      seq: 2,
      key: keysOfD[0]!,
      bytes: 1,
      hash: sha('d'),
    });
    for (const doc of [d, e])
      searchIndex.indexCheckpoint({
        tenant: h.tenant,
        doc,
        seq: 1,
        visibility: 'full',
        content: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'searchable words' }] }],
        },
      });
    expect(searchIndex.size(h.tenant)).toBeGreaterThan(0);
    const indexed = searchIndex.size(h.tenant);
    expect(await tablesMentioning(d)).toContain('doc_checkpoints');
    const keyOfE = objectKeys.checkpoint(h.tenant, e, 1);
    await h.parts.objects.put(keyOfE, bytes('e'));
    const own = randomUUID();
    const shared = randomUUID();
    const twin = randomUUID();
    const eOwn = randomUUID();
    const ownKey = await asset(d, own, 'only-d', [d]);
    const sharedKey = await asset(d, shared, 'shared-with-e', [d, e]);
    const twinKey = await asset(d, twin, 'same-bytes', [d]);
    await asset(e, eOwn, 'same-bytes', [e]);

    // Soft delete through the route; the event is raised then.
    const del = await h.call('DELETE', `/v1/documents/${d}`, { token: owner(d) });
    expect(del.status, del.text).toBe(204);
    const raised = h.events.of('dep.document.deleted.v1').length;
    expect(raised).toBeGreaterThanOrEqual(1);
    expect(await tablesMentioning(d)).toEqual(expect.arrayContaining(['doc_commits', 'documents']));

    // Not before the retention has passed: nothing is removed.
    const early = await purge.run(h.tenant, new Set(), Date.now() + 29 * DAY_MS);
    expect(early.purged).toEqual([]);
    expect(early.skipped).toContainEqual({ doc: d, reason: 'retention-running' });
    expect(await h.parts.objects.exists(keysOfD[0]!)).toBe(true);

    // After it: everything of the document goes.
    const run = await purge.run(h.tenant, new Set(), Date.now() + 31 * DAY_MS);
    expect(run.purged).toEqual([d]);

    // Criterion 1: no table mentions the document any more but the audit trail and the row of the
    // shared asset (`assets.doc_id` names the document it was uploaded for; no content, see Notes).
    expect(await tablesMentioning(d)).toEqual(['assets', 'audit_events']);
    for (const k of keysOfD) expect(await h.parts.objects.exists(k)).toBe(false);
    expect(await h.parts.objects.list(`${objectKeys.prefix(h.tenant)}docs/${d}/`)).toEqual([]);
    expect(await h.parts.objects.exists(ownKey)).toBe(false);
    // The search entries of the document are gone, those of the other document stay.
    expect(searchIndex.size(h.tenant)).toBeGreaterThan(0);
    expect(searchIndex.size(h.tenant)).toBeLessThan(indexed);

    // Criterion 2: the asset another document references is kept, with its row and its object; so is
    // the object whose content another asset still has, though the row of this document's own asset goes.
    expect(await h.parts.objects.exists(sharedKey)).toBe(true);
    expect(await h.parts.objects.exists(twinKey)).toBe(true);
    const left = await sql<{ id: string }>(
      'SELECT id FROM assets WHERE tenant_id = $1 ORDER BY id',
      [h.tenant],
    );
    expect(left.map((r) => r.id).sort()).toEqual([shared, eOwn].sort());
    // The other document is untouched.
    expect(await h.parts.objects.exists(keyOfE)).toBe(true);
    expect((await h.parts.logs.head(ref(e))).seq).toBe(1);
    expect((await h.parts.documents.get(ref(e)))?.deletedAt).toBeNull();

    // Criterion 4: asked for, the document is not found, by any route.
    for (const path of ['', '/content', '/history'])
      expect(
        (await h.call('GET', `/v1/documents/${d}${path}`, { token: h.apiKey })).status,
        path,
      ).toBe(404);

    // Criterion 6: audited, and the delete event was raised at delete time and not again.
    const audit = await h.parts.audit!.query(h.tenant, { kind: 'document.purged', limit: 10 });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ doc: d, actor: 'system' });
    expect(audit[0]!.data).toMatchObject({ assetsRemoved: 2, assetsKept: 1 });
    expect(h.events.of('dep.document.deleted.v1')).toHaveLength(raised);

    // A second run finds nothing to do.
    expect((await purge.run(h.tenant, new Set(), Date.now() + 31 * DAY_MS)).purged).toEqual([]);
  }, 60_000);

  it('does not purge a document under legal hold, or one whose sealed PDF is still retained (criterion 5)', async () => {
    const held = await newDoc('Held');
    const sealed = await newDoc('Sealed');
    await commit(held);
    await commit(sealed);
    const place = await h.call('POST', `/v1/documents/${held}/holds`, {
      token: h.apiKey,
      body: { reason: 'Matter 2026-41' },
    });
    expect(place.status, place.text).toBe(201);
    for (const d of [held, sealed])
      expect((await h.call('DELETE', `/v1/documents/${d}`, { token: owner(d) })).status).toBe(204);
    const sealedKey = `${objectKeys.prefix(h.tenant)}final/${sealed}/wf1.pdf`;
    await h.parts.objects.put(sealedKey, bytes('pdf'));
    const hash = sha('pdf');
    const retainUntil = new Date(Date.now() + 400 * DAY_MS).toISOString();
    await h.db!.admin.query(
      `INSERT INTO workflow_sealed_pdf (tenant_id, doc_id, workflow_id, sealed_hash, stored_hash, object_key, retain_until)
       VALUES ($1, $2, 'wf1', $3, $3, $4, $5)`,
      [h.tenant, sealed, hash, sealedKey, retainUntil],
    );
    const heldSet = await h.parts.holds!.heldDocuments(h.tenant);
    expect(heldSet.has(held)).toBe(true);

    const run = await purge.run(h.tenant, heldSet, Date.now() + 31 * DAY_MS);
    expect(run.purged).toEqual([]);
    expect(run.skipped).toEqual(
      expect.arrayContaining([
        { doc: held, reason: 'legal-hold' },
        { doc: sealed, reason: 'sealed-retained' },
      ]),
    );
    for (const d of [held, sealed]) {
      expect((await h.parts.logs.head(ref(d))).seq).toBe(1);
      expect(await h.parts.documents.get(ref(d))).not.toBeNull();
    }
    expect(await h.parts.objects.exists(sealedKey)).toBe(true);

    // Once the sealed PDF's retention has ended it goes with the document (owner decision 31).
    const later = await purge.run(h.tenant, heldSet, Date.now() + 500 * DAY_MS);
    expect(later.purged).toEqual([sealed]);
    expect(await h.parts.objects.exists(sealedKey)).toBe(false);
    expect(await h.parts.documents.get(ref(held))).not.toBeNull();
  }, 60_000);

  it('gives the purge role no more than the purge needs', async () => {
    const attempts = [
      'DELETE FROM audit_events',
      'DELETE FROM tenants',
      'DELETE FROM tenant_users',
      "INSERT INTO documents (id, tenant_id, cdm_version, created_by, created_at) VALUES (gen_random_uuid(), '" +
        h.tenant +
        "', 1, 'x', now())",
      'UPDATE doc_commits SET size = 0',
    ];
    for (const s of attempts) {
      const c = await purgePool.connect();
      try {
        await c.query('BEGIN');
        await c.query("SELECT set_config('docedit.tenant_id', $1, true)", [h.tenant]);
        await expect(c.query(s), s).rejects.toThrow(/permission denied/);
      } finally {
        await c.query('ROLLBACK').catch(() => {});
        c.release();
      }
    }
  });
});
