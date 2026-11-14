// BE-077 over PostgreSQL (lane U-BE-071-084): while the database is unreachable for the node, a
// commit is rejected with the retryable `unavailable` and a delay, nothing is stored in PostgreSQL,
// the channel stays open, and content reads answer `unavailable`. When the database returns, the same
// channel resumes without a restart and a resubmitted commit is stored once. The memory version is
// services/document-service/src/data-plane/outage.test.ts. The outage is the plane's test hook
// (BE-079), so PostgreSQL itself stays up; the test reads PostgreSQL directly to see what was stored.
// Skips when PostgreSQL is not up: pwsh -NoProfile -File infra/test-env.ps1 up
import { uuid7 } from '@docedit/model';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import {
  createTestDatabase,
  newTenant,
  pgStores,
  postgresUnavailable,
  type TestDatabase,
} from '../support/env.ts';
import { DataPlaneError } from '../../src/data-plane/wire.ts';
import { insertText } from './client.ts';
import { MemoryCheckpoints, startPlane, type Plane } from './support.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');
const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

describe.skipIf(unavailable !== null)('BE-077 over PostgreSQL (U-BE-071-084)', () => {
  let db: TestDatabase;
  const planes: Plane[] = [];

  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterEach(async () => {
    for (const p of planes.splice(0)) await p.close();
  });
  afterAll(async () => {
    await db?.drop();
  });

  it('rejects with a retry delay and stores nothing while the database is down, then resumes on the same channel and stores a resubmitted commit once', async () => {
    const s = pgStores(db.service);
    const tenant = newTenant();
    const p = await startPlane({
      stores: { logs: s.logs, ownership: s.logs, grants: s.grants, documents: s.docs },
      checkpoints: new MemoryCheckpoints(),
      tenant,
      node: 'node-a',
      settings: { testMode: true },
    });
    planes.push(p);
    const doc = await p.createDocument();
    const ref = p.ref(doc);
    const a = await p.client('alice', { [doc]: 'owner' });
    expect((await a.open(1, doc)).t).toBe('ch.opened');

    // The database is unreachable for the node: the commit is refused, with a delay.
    p.plane.hooks!.dropDatabase(true);
    const id = uuid7();
    const rejected = await a.submit(1, {
      id,
      base: 0,
      steps: [insertText(intro(), 'lost for now')],
    });
    expect(rejected.t).toBe('sync.reject');
    expect(rejected.d).toMatchObject({ id, code: 'unavailable', action: 'retry', head: 0 });
    expect(rejected.d!['retryAfterMs']).toBeGreaterThan(0);

    // Nothing was acknowledged, and PostgreSQL holds nothing for the document.
    expect(a.log.some((m) => m.t === 'sync.ack')).toBe(false);
    expect(await s.logs.read(ref)).toHaveLength(0);

    // Content reads answer unavailable during the outage.
    const identity = p.tokens.identity(p.tokens.issue({ user: 'alice', docs: { [doc]: 'owner' } }));
    const down = await p.plane.readContent(identity, doc).then(
      () => null,
      (e: unknown) => e,
    );
    expect(down).toBeInstanceOf(DataPlaneError);
    expect((down as DataPlaneError).code).toBe('unavailable');

    // The channel is not closed by the rejection.
    expect(a.closeInfo).toBeNull();

    // The database returns: the same channel resubmits the commit and it is stored once.
    p.plane.hooks!.dropDatabase(false);
    const ok = await a.submit(1, { id, base: 0, steps: [insertText(intro(), 'lost for now')] });
    expect(ok.t).toBe('sync.ack');
    expect(ok.d).toMatchObject({ id, seq: 1 });
    const dup = await a.submit(1, { id, base: 0, steps: [insertText(intro(), 'lost for now')] });
    expect(dup.d).toMatchObject({ id, seq: 1 });
    const next = await a.submit(1, { base: 1, steps: [insertText(intro(), 'after')] });
    expect(next.d).toMatchObject({ seq: 2 });
    expect((await s.logs.read(ref)).map((c) => c.id)).toEqual([id, next.d!['id']]);
    expect(a.closeInfo).toBeNull();

    const content = await p.plane.readContent(identity, doc);
    expect(content.seq).toBe(2);
  });
});
