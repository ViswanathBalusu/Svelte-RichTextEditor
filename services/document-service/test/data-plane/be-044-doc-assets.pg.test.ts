// BE-044 criteria 1, 3 and 5 over PostgreSQL (lane w5): the `doc_assets` row is written in the
// transaction that stores the commit, with the commit's seq as `first_seq`; it is not written when
// the transaction fails after its inserts; an asset of another tenant is not found; and the row is
// kept when the asset is no longer in the content. Skips when PostgreSQL is not up:
// pwsh -NoProfile -File infra/test-env.ps1 up
import { uuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { baseDoc } from '../../../../packages/authority/test/fixtures.ts';
import { PgAssetRegistry } from '../../src/control-plane/assets.ts';
import { RegistryAssetAttachments } from '../../src/data-plane/asset-attachments.ts';
import {
  createTestDatabase,
  newTenant,
  pgStores,
  postgresUnavailable,
  type TestDatabase,
} from '../support/env.ts';
import { basePermissions, startPlane, type Plane } from './support.ts';

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

function afterIntro(): number {
  const doc = cdmSchema().nodeFromJSON(baseDoc().toJSON());
  let at = -1;
  doc.descendants((n, pos) => {
    if (n.attrs['id'] === 'pIntro0000000001') at = pos + n.nodeSize;
  });
  return at;
}
const insertFigure = (asset: string, at = afterIntro(), id = 'fFigure000000001') => ({
  stepType: 'replace',
  from: at,
  to: at,
  slice: {
    content: [{ type: 'figure', attrs: { id, asset, width: 2400, height: 1800 } }],
  },
});

describe.skipIf(unavailable !== null)('doc_assets in the persist transaction (BE-044)', () => {
  let db: TestDatabase;
  let registry: PgAssetRegistry;
  let plane: Plane | undefined;

  beforeAll(async () => {
    db = await createTestDatabase();
    registry = new PgAssetRegistry(db.service);
  });
  afterEach(async () => {
    await plane?.close();
    plane = undefined;
  });
  afterAll(async () => {
    await db?.drop();
  });

  async function pgPlane(tenant: string): Promise<Plane> {
    const s = pgStores(db.service);
    plane = await startPlane({
      stores: { logs: s.logs, ownership: s.logs, grants: s.grants, documents: s.docs },
      tenant,
      settings: { testMode: true },
      deps: { assets: new RegistryAssetAttachments(s.logs, registry) },
    });
    return plane;
  }

  async function uploaded(tenant: string, doc: string, user: string): Promise<string> {
    const id = uuid7();
    await registry.create(
      tenant,
      {
        id,
        doc,
        filename: 'a.png',
        mime: 'image/png',
        declaredBytes: 10,
        createdBy: user,
        uploadExpiresAt: Date.now() + 60_000,
      },
      Date.now(),
    );
    await registry.settleReady(
      tenant,
      id,
      {
        sha256: 'a'.repeat(64),
        bytes: 10,
        contentType: 'image/png',
        objectKey: `k/${id}`,
        width: 10,
        height: 10,
        frames: null,
        renditions: [],
      },
      Date.now(),
    );
    return id;
  }

  const rows = async (doc: string) =>
    (
      await db.admin.query<{ asset_id: string; first_seq: string }>(
        'SELECT asset_id, first_seq FROM doc_assets WHERE doc_id = $1 ORDER BY first_seq',
        [doc],
      )
    ).rows.map((r) => [r.asset_id, Number(r.first_seq)] as const);

  it('writes the row with the commit seq as first_seq, once, and keeps it when the figure goes (criteria 1 and 5)', async () => {
    const tenant = newTenant();
    const p = await pgPlane(tenant);
    const doc = await p.createDocument();
    const asset = await uploaded(tenant, doc, 'alice');
    const alice = await p.client('alice', { [doc]: 'owner' });
    await alice.open(1, doc);
    const at = afterIntro();
    expect(await rows(doc)).toEqual([]);
    expect(await alice.submit(1, { base: 0, steps: [insertFigure(asset, at)] })).toMatchObject({
      t: 'sync.ack',
      d: { seq: 1 },
    });
    expect(await rows(doc)).toEqual([[asset, 1]]);
    // A second figure with the same asset does not move first_seq.
    const second = await alice.submit(1, {
      base: 1,
      steps: [insertFigure(asset, at, 'fFigure000000002')],
    });
    expect(second).toMatchObject({ t: 'sync.ack', d: { seq: 2 } });
    expect(await rows(doc)).toEqual([[asset, 1]]);
    // Both figures go: the content no longer references the asset and the row stays.
    const removed = await alice.submit(1, {
      base: 2,
      steps: [{ stepType: 'replace', from: at, to: at + 4, slice: { content: [] } }],
    });
    expect(removed.t).toBe('sync.ack');
    expect(await rows(doc)).toEqual([[asset, 1]]);
    expect(p.errors).toEqual([]);
  });

  it('writes no row when the transaction fails after its inserts, and one with the retried commit (criterion 1)', async () => {
    const tenant = newTenant();
    const p = await pgPlane(tenant);
    const doc = await p.createDocument();
    const asset = await uploaded(tenant, doc, 'alice');
    const alice = await p.client('alice', { [doc]: 'owner' });
    await alice.open(1, doc);
    p.plane.hooks!.failNextWrite(p.ref(doc), 'after-insert');
    const failed = await alice.submit(1, { base: 0, steps: [insertFigure(asset)] });
    expect(failed).toMatchObject({ t: 'sync.reject', d: { code: 'unavailable' } });
    expect(await rows(doc)).toEqual([]);
    expect((await p.stores.logs.head(p.ref(doc))).seq).toBe(0);
    expect(await alice.submit(1, { base: 0, steps: [insertFigure(asset)] })).toMatchObject({
      t: 'sync.ack',
      d: { seq: 1 },
    });
    expect(await rows(doc)).toEqual([[asset, 1]]);
  });

  it('refuses an asset of another tenant, and an asset another user uploaded (criteria 2 and 3)', async () => {
    const tenant = newTenant();
    const other = newTenant();
    const p = await pgPlane(tenant);
    const doc = await p.createDocument();
    // Another tenant's asset (its own document), and bob's upload for this document.
    const otherDoc = uuid7();
    await pgStores(db.service).docs.create(other, {
      id: otherDoc,
      cdmVersion: 1,
      requires: [],
      createdBy: 'alice',
      permissions: basePermissions(),
    });
    const theirs = await uploaded(other, otherDoc, 'alice');
    const bobs = await uploaded(tenant, doc, 'bob');
    const alice = await p.client('alice', { [doc]: 'owner' });
    await alice.open(1, doc);
    for (const asset of [theirs, bobs])
      expect(await alice.submit(1, { base: 0, steps: [insertFigure(asset)] })).toMatchObject({
        t: 'sync.reject',
        d: { code: 'invalid_op' },
      });
    expect(await rows(doc)).toEqual([]);
  });
});
