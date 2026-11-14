// SYN-043 criterion 1 over PostgreSQL (lane V-SYN-037-053): a room that writes a checkpoint sends
// `sync.check` with the durable `seq` and the SHA-256 of the canonical form of the document at that
// seq, to the channels that see the full document. The check is off when the settings turn it off.
// Skips, with the reason, when PostgreSQL is not up: pwsh -NoProfile -File infra/test-env.ps1 up
import { createHash } from 'node:crypto';
import { canonicalize, type JsonEnvelope } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { contentHash } from '../../src/data-plane/recovery.ts';
import {
  createTestDatabase,
  pgStores,
  postgresUnavailable,
  type TestDatabase,
} from '../support/env.ts';
import { insertText, type Received } from './client.ts';
import { startPlane, type Plane } from './support.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');
const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

const payload = (m: Received): { seq?: number; hash?: string } => (m.d ?? m) as never;

describe.skipIf(unavailable !== null)(
  'V-SYN-037-053: sync.check after a checkpoint over PostgreSQL (SYN-043 criterion 1)',
  () => {
    let db: TestDatabase;
    let plane: Plane | undefined;

    beforeAll(async () => {
      db = await createTestDatabase();
    });
    afterAll(async () => {
      await plane?.close().catch(() => {});
      await db?.drop();
    });

    const checkpointing = { everyCommits: 2, everyMs: 600_000, minIntervalMs: 0 };

    it('sends the durable seq and the SHA-256 of the canonical document with the checkpoint', async () => {
      const s = pgStores(db.service);
      plane = await startPlane({
        stores: { logs: s.logs, ownership: s.logs, grants: s.grants, documents: s.docs },
        settings: { checkpoint: checkpointing },
      });
      const doc = await plane.createDocument();
      const ref = plane.ref(doc);
      const alice = await plane.client('alice', { [doc]: 'owner' });
      const opened = await alice.open(1, doc);
      if (opened.t !== 'ch.opened') throw new Error(`open: ${JSON.stringify(opened)}`);

      for (const [i, text] of ['Check one', 'Check two'].entries()) {
        const r = await alice.submit(1, { base: i, steps: [insertText(intro(), text)] });
        if (r.t !== 'sync.ack') throw new Error(`submit ${i}: ${JSON.stringify(r)}`);
      }

      const check = await alice.take((m) => m.t === 'sync.check', 5000, 'sync.check');
      const { seq, hash } = payload(check);
      expect(seq).toBe(2);

      // The checkpoint the room stored at that seq holds the durable document; its canonical text
      // is hashed with SHA-256, and the message carries that hash.
      const envelope = (await plane.checkpoints.get(ref, 2)) as JsonEnvelope;
      expect(envelope, 'the checkpoint at seq 2').not.toBeNull();
      const expected = createHash('sha256').update(canonicalize(envelope)).digest('hex');
      expect(contentHash(envelope)).toBe(expected);
      expect(hash === expected || hash === `sha256:${expected}`).toBe(true);
    });

    it('sends nothing when the settings turn the divergence check off', async () => {
      const s = pgStores(db.service);
      await plane?.close();
      plane = await startPlane({
        stores: { logs: s.logs, ownership: s.logs, grants: s.grants, documents: s.docs },
        settings: { checkpoint: checkpointing, syncCheck: false } as never,
      });
      const doc = await plane.createDocument();
      const ref = plane.ref(doc);
      const alice = await plane.client('alice', { [doc]: 'owner' });
      await alice.open(1, doc);
      for (const [i, text] of ['Off one', 'Off two'].entries()) {
        const r = await alice.submit(1, { base: i, steps: [insertText(intro(), text)] });
        if (r.t !== 'sync.ack') throw new Error(`submit ${i}: ${JSON.stringify(r)}`);
      }
      // The room saves the checkpoint at seq 2 after the commits are answered: wait for it.
      for (let k = 0; k < 250 && (await plane!.checkpoints.get(ref, 2)) === null; k++)
        await new Promise((r) => setTimeout(r, 20));
      expect(await plane!.checkpoints.get(ref, 2), 'checkpoint at seq 2').not.toBeNull();
      await new Promise((r) => setTimeout(r, 100));
      expect(alice.all('sync.check')).toHaveLength(0);
    });
  },
);
