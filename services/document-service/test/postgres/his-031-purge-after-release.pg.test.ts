// HIS-031 criterion 2 (lane w7, 2026-11-18): a document deleted while a legal hold stands is
// soft-deleted, and the purge does not run until the hold is released. The hold is placed and released
// through the administration API, the delete is `DELETE /documents/{id}`, and the purge runs as the
// job does (`DocumentPurge`, `PgPurgeStore`, the role `docedit_purge`) with the held set the hold
// store gives. A second hold keeps the document after the first is released. Test values only.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DAY_MS, DocumentPurge } from '../../src/control-plane/document-purge.ts';
import { PgPurgeStore } from '../../src/control-plane/document-purge-pg.ts';
import { SearchIndex } from '../../src/control-plane/search-index.ts';
import type { DocRef } from '../../src/storage/types.ts';
import { ADMIN } from '../support/env.ts';
import { skipReason, startHarness, type Harness } from '../control-plane/support.ts';

const skip = await skipReason('postgres');
if (skip) console.warn(`skipped: ${skip}`);

describe.skipIf(skip !== null)('purge after the release of a legal hold (HIS-031, PostgreSQL)', () => {
  let h: Harness;
  let purgePool: pg.Pool;
  let purge: DocumentPurge;

  beforeAll(async () => {
    h = await startHarness('postgres', {});
    purgePool = new pg.Pool({ ...ADMIN, database: h.db!.name, max: 3 });
    purgePool.on('error', () => {});
    purgePool.on('connect', (c) => {
      void c.query('SET ROLE docedit_purge');
    });
    purge = new DocumentPurge({
      store: new PgPurgeStore(purgePool),
      objects: h.parts.objects,
      audit: h.parts.audit!,
      search: new SearchIndex(),
      retentionMs: 30 * DAY_MS,
      now: () => Date.now(),
    });
  }, 60_000);
  afterAll(async () => {
    await purgePool?.end();
    await h?.close();
  });

  const ref = (doc: string): DocRef => ({ tenant: h.tenant, doc });

  it('records the soft delete under a hold, purges nothing, and purges after the last release', async () => {
    const doc = await h.createDocument({ title: 'Held then released' });
    const owner = h.userToken({ [doc]: 'owner' }, { sub: `w7-owner-${randomUUID()}` });
    const first = (
      await h.call('POST', `/v1/documents/${doc}/holds`, {
        token: h.apiKey,
        body: { reason: 'Matter 2026-61' },
      })
    ).json as { id: string };
    const second = (
      await h.call('POST', `/v1/documents/${doc}/holds`, {
        token: h.apiKey,
        body: { reason: 'Matter 2026-62' },
      })
    ).json as { id: string };

    expect((await h.call('DELETE', `/v1/documents/${doc}`, { token: owner })).status).toBe(204);
    // The soft delete is recorded.
    const row = await h.parts.documents.get(ref(doc));
    expect(row?.deletedAt).not.toBeNull();

    const later = Date.now() + 31 * DAY_MS;
    const held = await h.parts.holds!.heldDocuments(h.tenant);
    expect(held.has(doc)).toBe(true);
    const underHold = await purge.run(h.tenant, held, later);
    expect(underHold.purged).toEqual([]);
    expect(underHold.skipped).toEqual(expect.arrayContaining([{ doc, reason: 'legal-hold' }]));
    expect(await h.parts.documents.get(ref(doc))).not.toBeNull();

    // One hold released: the other still keeps the document.
    expect(
      (await h.call('DELETE', `/v1/documents/${doc}/holds/${first.id}`, { token: h.apiKey }))
        .status,
    ).toBe(200);
    const stillHeld = await h.parts.holds!.heldDocuments(h.tenant);
    expect(stillHeld.has(doc)).toBe(true);
    expect((await purge.run(h.tenant, stillHeld, later)).purged).toEqual([]);

    // The last hold released: the normal schedule resumes, and the purge runs.
    expect(
      (await h.call('DELETE', `/v1/documents/${doc}/holds/${second.id}`, { token: h.apiKey }))
        .status,
    ).toBe(200);
    const free = await h.parts.holds!.heldDocuments(h.tenant);
    expect(free.has(doc)).toBe(false);
    const after = await purge.run(h.tenant, free, later);
    expect(after.purged).toEqual([doc]);
    expect(await h.parts.documents.get(ref(doc))).toBeNull();
  }, 60_000);
});
