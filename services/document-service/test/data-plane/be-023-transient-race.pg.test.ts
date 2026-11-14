/**
 * BE-023 criterion 4 (lane U-BE-015-028): a channel opens while a transient authority is writing
 * the same closed document, both over PostgreSQL. The transient authority holds the document's
 * write (a gated log store, so the overlap is certain, not timing luck). The channel must wait for
 * the transient run (`RoomHost.acquire` waits on `#transients`), and only then open. Both commits
 * end in the log once each, in order, with no gap and no duplicate; the typed commit is checked
 * against the head the prefill left.
 * The file skips, with the reason, when PostgreSQL is not up:
 * pwsh -NoProfile -File infra/test-env.ps1 up
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuid7 } from '@docedit/model';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { insertText } from './client.ts';
import { GatedLogStore, startPlane, until, type Plane } from './support.ts';
import {
  createTestDatabase,
  pgStores,
  postgresUnavailable,
  type TestDatabase,
} from '../support/env.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

describe.skipIf(unavailable !== null)(
  'a channel that opens during a transient run waits for it (BE-023 criterion 4, PostgreSQL)',
  () => {
    let db: TestDatabase;
    const planes: Plane[] = [];

    beforeAll(async () => {
      db = await createTestDatabase();
    });

    afterAll(async () => {
      for (const p of planes) await p.close().catch(() => {});
      await db?.drop();
    });

    it('lets the channel open only after the transient commit is stored, and stores both commits once in order', async () => {
      const pg = pgStores(db.service);
      const gated = new GatedLogStore(pg.logs);
      const a = await startPlane({
        stores: { logs: gated, ownership: pg.logs, grants: pg.grants, documents: pg.docs },
        node: 'node-u-be-023',
      });
      planes.push(a);
      const doc = await a.createDocument();
      const ref = a.ref(doc);

      // The transient authority: a server-authored prefill on a document with no open room.
      gated.hold = true;
      const prefillId = uuid7();
      const prefill = a.plane.host.apply(ref, {
        kind: 'author',
        id: prefillId,
        origin: 'prefill',
        actor: 'system',
        base: 0,
        steps: [insertText(intro(), 'Prefilled')],
      });
      await until(() => gated.pending === 1, 3000, 'the transient write to be held');
      expect(a.plane.host.transientCount).toBe(1);

      // A channel opens for the same document meanwhile; it must not open before the write settles.
      const alice = await a.client('alice', { [doc]: 'owner' });
      let opened = false;
      const openP = alice.open(1, doc).then((r) => {
        opened = true;
        return r;
      });
      await new Promise((r) => setTimeout(r, 150));
      expect(opened, 'the channel waits for the transient run').toBe(false);

      // Release the held write: the transient run stores seq 1 and exits.
      gated.hold = false;
      await gated.release();
      const seq = await prefill;
      expect(seq.seq).toBe(1);

      const aliceOpen = await openP;
      expect(aliceOpen.t).toBe('ch.opened');
      expect(a.plane.host.transientCount).toBe(0);

      // The channel's own commit is checked against the head the prefill left (1), and stored as 2.
      const id = uuid7();
      const r = await alice.submit(1, { id, base: 1, steps: [insertText(intro(), 'typed ')] });
      expect(r.t).toBe('sync.ack');
      expect(r.d!['seq']).toBe(2);

      // The log: exactly the two commits, in order, with no gap or duplicate.
      const stored = await pg.logs.read(ref);
      expect(stored.map((c) => c.seq)).toEqual([1, 2]);
      expect(stored[0]!.id).toBe(prefillId);
      expect(stored[1]!.id).toBe(id);
      expect(a.errors).toEqual([]);
    });
  },
);
