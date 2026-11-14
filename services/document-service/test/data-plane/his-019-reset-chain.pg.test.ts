/**
 * HIS-019 criterion 2 on PostgreSQL (FND-010 integration environment: pwsh -NoProfile -File
 * infra/test-env.ps1 up). A whole-document snapshot reaches every open client as `sync.reset` at a
 * new seq, the earlier commits read back unchanged, and the hash chain still verifies end to end
 * after the snapshot (the stored previous hash of each row links to the row before it, HIS-002).
 * The in-memory version without the chain check is his-019-snapshot-history.test.ts. The client's
 * reload on `sync.reset` is the engine's (packages/engine/test/sync-state.test.ts, "reset on a
 * snapshot (SYN-023)"); the restore reason and the `pre-restore` and `restore` versions are not built.
 */
import type { JsonEnvelope } from '@docedit/model';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BASE_JSON, baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import type { PgLogStore } from '../../src/index.ts';
import {
  pgStores,
  postgresUnavailable,
  createTestDatabase,
  type TestDatabase,
} from '../support/env.ts';
import { insertText } from './client.ts';
import { REQUIRES, startPlane, type Plane } from './support.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');

/** The content a whole-document snapshot stores (06 §2.2); the fixture document, as in his-019. */
const fixtureContent = () =>
  ({ cdm: 1, requires: [...REQUIRES], doc: structuredClone(BASE_JSON) }) as unknown as JsonEnvelope;

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

describe.skipIf(unavailable !== null)(
  'HIS-019 criterion 2 on PostgreSQL: a snapshot resets every client and keeps the chain',
  () => {
    let db: TestDatabase;
    let planes: Plane[] = [];

    beforeAll(async () => {
      db = await createTestDatabase();
    });
    afterEach(async () => {
      for (const p of planes) await p.close();
      planes = [];
    });
    afterAll(async () => {
      await db?.drop();
    });

    it('sends sync.reset to every open client, keeps earlier commits and the chain, and takes a new seq', async () => {
      const s = pgStores(db.service);
      const p = await startPlane({
        stores: { logs: s.logs, ownership: s.logs, grants: s.grants, documents: s.docs },
      });
      planes.push(p);
      const logs = s.logs as PgLogStore;

      const doc = await p.createDocument();
      const alice = await p.client('alice', { [doc]: 'owner' });
      const bob = await p.client('bob', { [doc]: 'editor' });
      await alice.open(1, doc);
      await bob.open(1, doc);

      // Two ordinary commits before the restore, so there is a history to keep.
      const first = await bob.submit(1, { base: 0, steps: [insertText(intro(), 'one ')] });
      expect(first.t).toBe('sync.ack');
      const second = await bob.submit(1, {
        base: (first.d as { seq: number }).seq,
        steps: [insertText(intro(), 'two ')],
      });
      expect(second.t).toBe('sync.ack');
      const ref = p.ref(doc);
      const headBefore = await logs.head(ref);
      const earlier = await logs.read(ref, 1, headBefore.seq);
      expect(earlier.length).toBe(headBefore.seq);
      expect((await logs.verify(ref, { payloads: true })).ok).toBe(true);

      const { seq } = await p.plane.replaceContent(ref, fixtureContent(), 'alice');

      // A new seq, after the head before the snapshot.
      expect(seq).toBe(headBefore.seq + 1);
      for (const c of [alice, bob]) {
        const reset = await c.take((m) => m.t === 'sync.reset');
        expect(reset.d).toMatchObject({ seq });
      }
      // The history is not rewritten: each earlier commit reads back exactly as it was written.
      expect(await logs.read(ref, 1, headBefore.seq)).toEqual(earlier);
      const headAfter = await logs.head(ref);
      expect(headAfter.seq).toBe(seq);
      // The chain still verifies end to end, with the payloads hashed again.
      const verdict = await logs.verify(ref, { payloads: true });
      expect(verdict.ok).toBe(true);
      expect(verdict).toMatchObject({ head: seq });
    });
  },
);
