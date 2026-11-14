// SYN-041 criterion 2 and the window over PostgreSQL (lane U-SYN-037-053): the same room output
// as syn-041-coalescing.test.ts, with the logs, ownership, grants and documents in the PostgreSQL
// stores. The window acts after the write, so the store should not change what is seen; this test
// shows it on the real stores. Each run creates its own tenant and database and drops it after.
// Skips when PostgreSQL is not up: pwsh -NoProfile -File infra/test-env.ps1 up
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import {
  createTestDatabase,
  newTenant,
  pgStores,
  postgresUnavailable,
  type TestDatabase,
} from '../support/env.ts';
import { insertText, type DepClient, type Received } from './client.ts';
import { startPlane, until, type Plane } from './support.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');
const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

const commitSeqs = (m: Received): number[] => m.d!['commits'].map((x: { seq: number }) => x.seq);
const commitBatches = (c: DepClient) => c.all('sync.commit', 1).map(commitSeqs);

describe.skipIf(unavailable !== null)(
  'the room coalesces its broadcasts over PostgreSQL (SYN-041 U-SYN-037-053)',
  () => {
    let db: TestDatabase;
    let plane: Plane | undefined;

    beforeAll(async () => {
      db = await createTestDatabase();
    });
    afterEach(async () => {
      await plane?.close();
      plane = undefined;
    });
    afterAll(async () => {
      await db?.drop();
    });

    async function pgPlane(settings: Record<string, unknown>): Promise<Plane> {
      const s = pgStores(db.service);
      plane = await startPlane({
        stores: { logs: s.logs, ownership: s.logs, grants: s.grants, documents: s.docs },
        tenant: newTenant(),
        settings: { coalescing: settings } as never,
      });
      return plane;
    }

    async function room(p: Plane) {
      const doc = await p.createDocument();
      const alice = await p.client('alice', { [doc]: 'owner' });
      const carol = await p.client('carol', { [doc]: 'editor' });
      const frank = await p.client('frank', { [doc]: 'viewer' });
      for (const c of [alice, carol, frank]) await c.open(1, doc);
      return { alice, carol, frank };
    }

    it('holds a commit on a window, then sends it before the acknowledgement of a later commit', async () => {
      const p = await pgPlane({ windowMs: 2000, minSubscribers: 3 });
      const { alice, carol, frank } = await room(p);
      expect(
        (await alice.submit(1, { base: 0, steps: [insertText(intro(), 'a')] })).d,
      ).toMatchObject({ seq: 1 });
      await new Promise((r) => setTimeout(r, 50));
      expect(carol.all('sync.commit', 1)).toHaveLength(0);
      expect(frank.all('sync.commit', 1)).toHaveLength(0);
      const ack = await carol.submit(1, { base: 0, steps: [insertText(intro(), 'c')] });
      expect(ack.t).toBe('sync.ack');
      expect(ack.d).toMatchObject({ seq: 2 });
      const carolOrder = carol.log
        .filter((m) => m.ch === 1 && (m.t === 'sync.commit' || m.t === 'sync.ack'))
        .map((m) => (m.t === 'sync.commit' ? [m.t, commitSeqs(m)] : [m.t, m.d!['seq']]));
      expect(carolOrder).toEqual([
        ['sync.commit', [1]],
        ['sync.ack', 2],
      ]);
      await until(() => frank.all('sync.commit', 1).length > 0, 5000, 'the held message');
      expect(commitBatches(frank)).toEqual([[1, 2]]);
      expect(p.errors).toEqual([]);
    });

    it('sends commits that arrive within one window as one sync.commit message', async () => {
      const p = await pgPlane({ windowMs: 400, minSubscribers: 3 });
      const { alice, frank } = await room(p);
      for (let i = 0; i < 3; i++)
        expect((await alice.submit(1, { base: i, steps: [insertText(intro(), `${i}`)] })).t).toBe(
          'sync.ack',
        );
      await until(() => commitBatches(frank).flat().length === 3, 5000, 'three commits');
      expect(commitBatches(frank)).toEqual([[1, 2, 3]]);
      expect(p.errors).toEqual([]);
    });
  },
);
