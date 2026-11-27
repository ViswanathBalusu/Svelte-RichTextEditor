// BE-094: `DocumentStore.setCdmVersion` over PostgreSQL, the one write the operator's migration makes
// to a document's record (ADR 0435). It changes the version only from the one the caller names, and
// refuses a missing or deleted document. Skips when PostgreSQL is not up:
// pwsh -NoProfile -File infra/test-env.ps1 up
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  pgStores,
  postgresUnavailable,
  type TestDatabase,
} from '../support/env.ts';
import { startPlane, type Plane } from './support.ts';

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

describe.skipIf(unavailable !== null)('setCdmVersion over PostgreSQL (BE-094)', () => {
  let db: TestDatabase;
  let p: Plane;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db?.drop();
  });
  afterEach(async () => {
    await p?.close();
  });

  it('moves a document from the version named and from no other, and refuses a deleted one', async () => {
    const s = pgStores(db.service);
    p = await startPlane({
      stores: { logs: s.logs, ownership: s.logs, grants: s.grants, documents: s.docs },
    });
    const doc = await p.createDocument();
    const ref = p.ref(doc);

    expect(await s.docs.setCdmVersion(ref, 2, 3)).toBe(false);
    expect((await s.docs.get(ref))!.cdmVersion).toBe(1);
    expect(await s.docs.setCdmVersion(ref, 1, 2)).toBe(true);
    expect((await s.docs.get(ref))!.cdmVersion).toBe(2);
    expect(await s.docs.setCdmVersion(ref, 1, 2)).toBe(false);

    await s.docs.remove(ref, { actor: 'system' });
    await expect(s.docs.setCdmVersion(ref, 2, 3)).rejects.toThrow(/no document/);
    await expect(
      s.docs.setCdmVersion({ tenant: p.tenant, doc: crypto.randomUUID() }, 1, 2),
    ).rejects.toThrow(/no document/);
  });
});
