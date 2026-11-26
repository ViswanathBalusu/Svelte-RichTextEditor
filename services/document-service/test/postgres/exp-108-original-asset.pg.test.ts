// EXP-108 criteria 2 to 4, over the control plane on PostgreSQL: the original Word file of an import
// stays attached to its document. The import version names it (criterion 4); a reader who sees the
// whole document resolves it to a signed URL of a Word file, and a reader of a projection does not
// (criterion 2; the origin serves it as an attachment, services/asset-worker/test/origin.test.ts);
// the retention sweep of orphan assets keeps it, and a purge of the document removes it with the
// document (criterion 3). The importer is a stand-in that returns CDM content.
import { randomBytes } from 'node:crypto';
import { NOTHING_HIDDEN, type Visibility } from '@docedit/authority';
import { uuid7 } from '@docedit/model';
import { unsandboxed } from '@docedit/asset-worker';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sweepAbandonedUploads } from '../../src/control-plane/asset-sweep.ts';
import { DAY_MS, DocumentPurge } from '../../src/control-plane/document-purge.ts';
import { PgPurgeStore } from '../../src/control-plane/document-purge-pg.ts';
import {
  DOCX_CONTENT_TYPE,
  ORIGINAL_NOTE,
  type DocxImporter,
} from '../../src/control-plane/imports.ts';
import { objectKeys } from '../../src/objects/store.ts';
import { FULL_VIEWS } from '../../src/control-plane/visibility.ts';
import type { DocRef } from '../../src/storage/types.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
} from '../control-plane/support.ts';
import { ADMIN } from '../support/env.ts';

const LEGAL = 'rLegal0000000001';
const URL_KEY = { id: 'k1', secret: randomBytes(32) };

/** The legal region is hidden from everyone but owners: a viewer reads a projection. */
const visibility: Visibility = (conn) =>
  conn.role === 'owner'
    ? NOTHING_HIDDEN
    : { regions: new Set([LEGAL]), values: new Set(), titles: false };

const skip = await skipReason('postgres');
if (skip) console.warn(`skipped: ${skip}`);

const importer: DocxImporter = async (bytes) => {
  const c = JSON.parse(JSON.stringify(documentWithRegions())) as {
    doc: { content: Array<{ content: Array<Record<string, unknown>> }> };
  };
  c.doc.content[1]!.content = [
    {
      type: 'paragraph',
      attrs: { id: 'pImport000000001', style: 'Normal' },
      content: [{ type: 'text', text: new TextDecoder().decode(bytes) }],
    },
  ];
  return { envelope: c, warnings: [] };
};

describe.skipIf(skip !== null)('the original Word file stays with its document (EXP-108)', () => {
  let h: Harness;
  let purgePool: pg.Pool;
  beforeAll(async () => {
    h = await startHarness('postgres', {
      importer,
      realDataPlane: true,
      views: { ...FULL_VIEWS, visibility },
      assetWorker: { sandbox: unsandboxed(), allowUnsandboxed: true },
      config: {
        jobIdleMs: 20,
        jobLeaseMs: 2000,
        assetOrigin: 'https://assets.tests.example',
        assetUrlKey: `${URL_KEY.id}:${URL_KEY.secret.toString('base64')}`,
      },
    });
    purgePool = new pg.Pool({ ...ADMIN, database: h.db!.name, max: 2 });
    purgePool.on('error', () => {});
    purgePool.on('connect', (c) => {
      void c.query('SET ROLE docedit_purge');
    });
  }, 60_000);
  afterAll(async () => {
    await purgePool?.end();
    await h?.close();
  });

  /** A ready asset of `doc` whose bytes are `text`, as the asset worker leaves one. */
  async function readyAsset(doc: string, text: string, filename: string, contentType: string) {
    const id = uuid7();
    const bytes = new TextEncoder().encode(text);
    const sha = await h.service.assets.putFinal(h.tenant, bytes, contentType);
    await h.parts.assetRegistry.create(
      h.tenant,
      {
        id,
        doc,
        filename,
        mime: contentType,
        declaredBytes: bytes.length,
        createdBy: 'system',
        uploadExpiresAt: h.now() + 60_000,
      },
      h.now(),
    );
    await h.parts.assetRegistry.settleReady(
      h.tenant,
      id,
      {
        sha256: sha,
        bytes: bytes.length,
        contentType,
        objectKey: objectKeys.asset(h.tenant, sha),
        width: null,
        height: null,
        frames: null,
        renditions: [],
      },
      h.now(),
    );
    return id;
  }

  it('is named by the import version, resolved for whole-document readers only, kept by the sweep and purged with the document', async () => {
    const doc = await h.createDocument({ content: documentWithRegions() });
    const ref: DocRef = { tenant: h.tenant, doc };
    const original = await readyAsset(doc, 'Original text', 'draft.docx', DOCX_CONTENT_TYPE);
    const stray = await readyAsset(doc, 'Stray picture', 'stray.png', 'image/png');

    const job = await h.call('POST', `/v1/documents/${doc}/imports`, {
      token: h.apiKey,
      body: { asset: original, format: 'docx' },
    });
    expect(job.status).toBe(202);
    let seq = 0;
    for (let i = 0; i < 300 && seq === 0; i++) {
      const r = await h.call('GET', `/v1/imports/${job.json.id as string}`, { token: h.apiKey });
      if (r.json.state === 'failed') throw new Error(JSON.stringify(r.json));
      seq = r.json.state === 'completed' ? (r.json.seq as number) : 0;
      if (seq === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(seq).toBeGreaterThan(0);

    // Criterion 4: the version of kind `import` names the original asset.
    // The hook of the settled job creates the version, a moment after the job reports completed.
    let versions = await h.parts.versions!.list(ref, { kind: 'import' });
    for (let i = 0; i < 200 && versions.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      versions = await h.parts.versions!.list(ref, { kind: 'import' });
    }
    expect(versions).toHaveLength(1);
    expect(versions[0]!.note).toBe(`${ORIGINAL_NOTE} ${original}`);

    // The original is attached from the import commit on.
    const row = await h.db!.admin.query<{ first_seq: string }>(
      'SELECT first_seq FROM doc_assets WHERE doc_id = $1 AND asset_id = $2',
      [doc, original],
    );
    expect(row.rows.map((r) => Number(r.first_seq))).toEqual([seq]);

    // Criterion 2: a reader who sees the whole document gets a signed URL of a Word file; a reader
    // of a projection does not, and a user with no role on the document is refused.
    const owner = h.userToken({ [doc]: 'owner' }, { sub: 'olga-108' });
    const viewer = h.userToken({ [doc]: 'viewer' }, { sub: 'vera-108' });
    const stranger = h.userToken({}, { sub: 'otto-108' });
    const resolve = (token: string) =>
      h.call('POST', `/v1/documents/${doc}/assets/resolve`, {
        token,
        body: { assets: [original] },
      });
    const whole = await resolve(owner);
    expect(whole.status).toBe(200);
    expect(whole.json.assets).toHaveLength(1);
    expect(whole.json.assets[0].contentType).toBe(DOCX_CONTENT_TYPE);
    expect(whole.json.assets[0].url).toMatch(/\.docx\?/);
    const projected = await resolve(viewer);
    expect(projected.status).toBe(200);
    expect(projected.json.assets).toEqual([]);
    expect((await resolve(stranger)).status).toBeGreaterThanOrEqual(400);

    // Criterion 3: the retention sweep of orphan assets removes the stray asset and keeps the original.
    const removed = await sweepAbandonedUploads(
      { assets: h.parts.assetRegistry, objects: h.parts.objects, orphanRetentionMs: 1 },
      h.tenant,
      Date.now() + DAY_MS,
    );
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await h.parts.assetRegistry.get(h.tenant, stray)).toBeNull();
    expect((await h.parts.assetRegistry.get(h.tenant, original))?.state).toBe('ready');

    // Criterion 3: the purge of the deleted document removes the original with it.
    expect((await h.call('DELETE', `/v1/documents/${doc}`, { token: owner })).status).toBe(204);
    const purge = new DocumentPurge({
      store: new PgPurgeStore(purgePool),
      objects: h.parts.objects,
      audit: h.parts.audit!,
      retentionMs: 30 * DAY_MS,
      now: () => Date.now(),
    });
    const early = await purge.run(h.tenant, new Set(), Date.now() + 29 * DAY_MS);
    expect(early.purged).not.toContain(doc);
    expect(await h.parts.assetRegistry.get(h.tenant, original)).not.toBeNull();
    const run = await purge.run(h.tenant, new Set(), Date.now() + 31 * DAY_MS);
    expect(run.purged).toContain(doc);
    expect(await h.parts.assetRegistry.get(h.tenant, original)).toBeNull();
  });
});
