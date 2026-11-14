/**
 * SEC-031 — the log has exactly one writer per document at any moment, so history has no forks,
 * gaps or duplicates (10 §3.3; 06 §2.1, §8). A write is fenced by the ownership epoch, and the
 * primary key (document, seq) is the last line of defence.
 *
 * The takeover is produced by a competing ownership claim that raises the epoch (as a recovering
 * node does), then node A's room — still on the old epoch — tries to append. The node lease that
 * decides who should try is BE-018; the freeze and partition of the full chaos run use the fault
 * hooks of BE-079 (1b), so this phase-1a proof drives the epoch and the primary key directly
 * against the real room and storage (SEC-031 Notes).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StoredCommit, WriteRequest } from '@docedit/authority';
import { uuid7 } from '@docedit/model';
import {
  documentWithRegions,
  insertText,
  posInside,
  postgresUnavailable,
  startHarness,
  type Harness,
  type Storage,
} from './support/harness.ts';
import { WireClient } from './support/wire.ts';

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null; // probed at collection so skipIf-style skips apply (SEC harness)
  describe(`SEC-031 two writers cannot both append (${storage})`, () => {
    let h: Harness;
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage, { node: 'node-A' });
    });
    afterAll(async () => {
      await h?.close();
    });
    const t = () => (skip ? it.skip : it);

    t()(
      'a node whose epoch is stale cannot append; its room stops and closes channels unavailable',
      async () => {
        const doc = await h.createDocument(h.a, documentWithRegions());
        const ref = { tenant: h.a.id, doc };
        const token = await h.mintToken(h.a, 'ann', { [doc]: 'editor' });
        const a = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
        try {
          await a.hello(token);
          await a.open(1, doc);
          const content = (
            await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey })
          ).json;
          const pos = posInside(content.doc, 'pIntro0000000001');
          // Node A owns the document and stores a commit.
          expect(
            (await a.submit(1, { id: uuid7(), base: 0, steps: [insertText(pos, 'A')] })).t,
          ).toBe('sync.ack');
          const epoch1 = (await h.parts.logs.head(ref)).epoch;
          const headBefore = (await h.parts.logs.head(ref)).seq;

          // A competing node takes ownership, raising the epoch (06 §2.1); node A is now fenced.
          const epoch2 = await h.parts.ownership.claim(ref, 'node-B');
          expect(epoch2).toBeGreaterThan(epoch1); // the epoch only increases

          // Node A, still believing it owns the document, submits again. Its write is fenced, the
          // room stops and the channel closes with unavailable; nothing of A's late work is stored.
          const late = await a
            .submit(1, { id: uuid7(), base: headBefore, steps: [insertText(pos, 'LATE')] })
            .catch(() => null);
          if (!late || late.t !== 'sync.reject') {
            const closed = await a.take(
              (m) => m.t === 'ch.closed',
              5000,
              "node A's channel closing",
            );
            expect(closed.d?.['code']).toBe('unavailable');
          }

          // The stored log has contiguous sequence numbers and no duplicates, and A's write did not land.
          const headAfter = (await h.parts.logs.head(ref)).seq;
          expect(headAfter).toBe(headBefore);
          const seqs = (await h.parts.logs.read(ref, 1)).map((c) => c.seq);
          expect(new Set(seqs).size).toBe(seqs.length);
          expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
        } finally {
          a.terminate();
        }
      },
    );

    t()(
      'two appends of the same seq under the same epoch: exactly one is stored (the primary key)',
      async () => {
        const doc = await h.createDocument(h.a, documentWithRegions());
        const ref = { tenant: h.a.id, doc };
        const epoch = await h.parts.ownership.claim(ref, 'node-A');
        const head = await h.parts.logs.head(ref);
        const rev = (await h.parts.grants.current(ref)).revision;
        const seq = head.seq + 1;
        const commit = (id: string): StoredCommit => ({
          seq,
          id,
          kind: 'steps',
          steps: [
            {
              stepType: 'replace',
              from: 1,
              to: 1,
              slice: { content: [{ type: 'text', text: 'x' }] },
            },
          ],
          user: 'system',
          session: '',
          time: Date.now(),
          origin: 'input',
          scopes: ['body'],
          revision: rev,
          cdm: 1,
          engine: 'pm-steps/1',
          retired: [],
          claimed: [],
          base: head.seq,
          rebased: false,
        });
        const req = (id: string): WriteRequest => ({
          epoch,
          revision: rev,
          fromSeq: seq,
          commits: [commit(id)],
        });
        const [r1, r2] = await Promise.all([
          h.parts.logs.append(ref, req(uuid7())),
          h.parts.logs.append(ref, req(uuid7())),
        ]);
        const statuses = [r1.status, r2.status].sort();
        expect(statuses).toContain('ok'); // exactly one wins
        expect(statuses).toContain('fenced'); // the other is refused by the (document, seq) key
      },
    );
  });
}
