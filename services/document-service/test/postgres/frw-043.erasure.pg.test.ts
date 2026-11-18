// FRW-043 criteria 3 and 4 (erasure half), lane w4, 2026-11-18: the erasure of one workflow
// participant over PostgreSQL. Their evidence rows are deleted, the payloads of the commits that
// hold their field values become tombstones, the hash chain still verifies, another participant's
// rows and commits are untouched, a legal hold refuses the erasure, and the audit entry holds counts
// only. The database is made for this file and dropped afterwards. Test values only.
import { uuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommitTombstone, type TombstoneStore } from '../../src/control-plane/commit-tombstone.ts';
import { PgTombstoneStore } from '../../src/control-plane/commit-tombstone-pg.ts';
import { ObjectCheckpointStore } from '../../src/objects/checkpoints.ts';
import { objectKeys } from '../../src/objects/store.ts';
import type { PgLogStore } from '../../src/storage/log-store.ts';
import type { DocRef } from '../../src/storage/types.ts';
import { PgEvidenceLedger } from '../../src/workflow/evidence-ledger-pg.ts';
import {
  eraseParticipant,
  PARTICIPANT_ERASURE_REASON,
  type ParticipantErasureDeps,
} from '../../src/workflow/participant-erasure.ts';
import {
  PgParticipantCommits,
  PgParticipantEvidence,
} from '../../src/workflow/participant-erasure-pg.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
} from '../control-plane/support.ts';
import { ADMIN } from '../support/env.ts';

const skip = await skipReason('postgres');
if (skip) console.warn(`skipped: ${skip}`);

describe.skipIf(skip !== null)('erasing one workflow participant (FRW-043, PostgreSQL)', () => {
  let h: Harness;
  let purgePool: pg.Pool;
  let inner: TombstoneStore | null = null;
  const lazy: TombstoneStore = {
    state: (...a) => inner!.state(...a),
    remove: (...a) => inner!.remove(...a),
  };
  let doc = '';
  let held = '';
  let bob = '';
  let carol = '';
  let deps: ParticipantErasureDeps;
  const ref = (d: string): DocRef => ({ tenant: h.tenant, doc: d });

  beforeAll(async () => {
    h = await startHarness('postgres', { parts: { tombstoneStore: lazy } });
    purgePool = new pg.Pool({ ...ADMIN, database: h.db!.name, max: 3 });
    purgePool.on('error', () => {});
    purgePool.on('connect', (c) => {
      void c.query('SET ROLE docedit_purge');
    });
    inner = new PgTombstoneStore(purgePool);
    const stone = new CommitTombstone({
      store: lazy,
      documents: h.parts.documents,
      checkpoints: h.parts.checkpointIndex!,
      objects: h.parts.objects,
      audit: h.parts.audit!,
      held: async (t, d) => h.parts.holds!.inForce(t, d),
      now: () => h.now(),
    });
    bob = (await h.parts.users.resolve(h.tenant, 'bob')).surrogate;
    carol = (await h.parts.users.resolve(h.tenant, 'carol')).surrogate;
    deps = {
      evidence: new PgParticipantEvidence(h.db!.service),
      commits: new PgParticipantCommits(h.db!.service),
      checkpoints: h.parts.checkpointIndex!,
      tombstone: (t, d, s, a, r) => stone.tombstone(t, d, s, a, r),
      audit: h.parts.audit!,
      held: async (t, d) => h.parts.holds!.inForce(t, d),
      surrogateOf: async (_t, _d, participant) =>
        participant === 'p-bob' ? bob : participant === 'p-carol' ? carol : null,
      now: () => h.now(),
    };
  }, 60_000);
  afterAll(async () => {
    await purgePool?.end();
    await h?.close();
  });

  /**
   * A document with four commits: bob fills a field (seq 1 and 3), carol fills another (seq 2) and
   * bob writes in the body (seq 4, no field scope). A checkpoint covers seq 1 to 3 when asked.
   */
  async function documentWithFills(title: string, checkpoint: boolean): Promise<string> {
    const d = await h.createDocument({ content: documentWithRegions(), title });
    const root = cdmSchema().nodeFromJSON(
      (await h.call('GET', `/v1/documents/${d}/content`, { token: h.apiKey })).json.doc,
    );
    let pos = -1;
    root.descendants((node, p) => {
      if (pos < 0 && node.isTextblock) pos = p + 1;
      return pos < 0;
    });
    const r = ref(d);
    const epoch = await h.parts.ownership.claim(r, 'test-node');
    const plan: Array<[string, string, string]> = [
      [bob, 'field:f-bob', 'A'],
      [carol, 'field:f-carol', 'B'],
      [bob, 'field:f-bob', 'C'],
      [bob, 'body', 'D'],
    ];
    for (const [user, scope, letter] of plan) {
      const head = await h.parts.logs.head(r);
      const perms = await h.parts.grants.current(r);
      const res = await h.parts.logs.append(r, {
        epoch,
        revision: perms.revision,
        fromSeq: head.seq + 1,
        commits: [
          {
            seq: head.seq + 1,
            id: uuid7(),
            kind: 'steps' as const,
            steps: [
              {
                stepType: 'replace',
                from: pos,
                to: pos,
                slice: { content: [{ type: 'text', text: letter }] },
              },
            ] as never,
            user,
            session: 's',
            time: h.now(),
            origin: 'fill',
            scopes: [scope],
            revision: perms.revision,
            cdm: 1,
            engine: 'pm-steps/1',
            retired: [],
            claimed: [],
          },
        ],
      });
      if (res.status !== 'ok') throw new Error(`append refused: ${res.status}`);
    }
    if (checkpoint) {
      const at3 = (await h.call('GET', `/v1/documents/${d}/content?seq=3`, { token: h.apiKey }))
        .json;
      await new ObjectCheckpointStore(h.parts.objects).put(r, 3, {
        cdm: at3.cdm,
        requires: at3.requires,
        doc: at3.doc,
      });
      await h.parts.checkpointIndex!.record(r, {
        seq: 3,
        key: objectKeys.checkpoint(h.tenant, d, 3),
        bytes: 1,
        hash: 'c'.repeat(64),
      });
    }
    return d;
  }

  async function evidenceFor(d: string): Promise<void> {
    const ledger = new PgEvidenceLedger(h.db!.service, { now: () => h.now() });
    for (const participant of ['p-bob', 'p-carol'])
      for (const item of ['viewed', 'consent'])
        await ledger.record(h.tenant, {
          doc: d,
          participant,
          kind: 'signer',
          item,
          facts: {
            items: { session: `session-of-${participant}` },
            ipAddress: '203.0.113.7',
            userAgent: 'Test agent 1.0',
          },
        });
  }

  const payloadSeqs = async (d: string): Promise<number[]> =>
    (
      await h.db!.admin.query<{ seq: string }>(
        'SELECT seq FROM doc_commit_payloads WHERE doc_id = $1 ORDER BY seq',
        [d],
      )
    ).rows.map((x) => Number(x.seq));
  const evidenceCount = async (d: string, who: string): Promise<number> =>
    (
      await h.db!.admin.query(
        'SELECT 1 FROM workflow_evidence WHERE doc_id = $1 AND participant = $2',
        [d, who],
      )
    ).rowCount ?? 0;

  it('refuses under a legal hold, and when a commit has no checkpoint, and changes nothing', async () => {
    held = await documentWithFills('Held', true);
    await evidenceFor(held);
    expect(
      (
        await h.call('POST', `/v1/documents/${held}/holds`, {
          token: h.apiKey,
          body: { reason: 'Matter 2026-41' },
        })
      ).status,
    ).toBe(201);
    await expect(
      eraseParticipant(deps, { ref: ref(held), participant: 'p-bob', actor: 'system' }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await payloadSeqs(held)).toEqual([1, 2, 3, 4]);
    expect(await evidenceCount(held, 'p-bob')).toBe(2);

    // No checkpoint: bob's commits are above the newest one, so a room would need their payloads.
    const bare = await documentWithFills('No checkpoint', false);
    await evidenceFor(bare);
    await expect(
      eraseParticipant(deps, { ref: ref(bare), participant: 'p-bob', actor: 'system' }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await payloadSeqs(bare)).toEqual([1, 2, 3, 4]);
    expect(await evidenceCount(bare, 'p-bob')).toBe(2);
    expect(
      (await h.parts.audit!.query(h.tenant, { kind: 'evidence.erased', limit: 10 })).length,
    ).toBe(0);
  }, 60_000);

  it('removes the evidence, tombstones the field values, keeps the chain, and audits counts only', async () => {
    doc = await documentWithFills('Erasure', true);
    await evidenceFor(doc);
    const logs = h.parts.logs as PgLogStore;
    const verdictBefore = await logs.verify(ref(doc));
    expect(verdictBefore).toMatchObject({ ok: true });
    const metaBefore = (
      await h.db!.admin.query<{ t: string }>(
        'SELECT to_jsonb(c)::text AS t FROM doc_commits c WHERE doc_id = $1 ORDER BY seq',
        [doc],
      )
    ).rows.map((x) => x.t);

    const out = await eraseParticipant(deps, {
      ref: ref(doc),
      participant: 'p-bob',
      actor: 'system',
    });
    expect(out).toEqual({ evidenceRows: 2, tombstones: 2, checkpointCopies: [3] });

    // Bob's evidence is gone and carol's is not.
    expect(await evidenceCount(doc, 'p-bob')).toBe(0);
    expect(await evidenceCount(doc, 'p-carol')).toBe(2);
    // Bob's field commits (1 and 3) have tombstones; carol's field commit and bob's body commit stay.
    expect(await payloadSeqs(doc)).toEqual([2, 4]);
    const stones = await h.db!.admin.query<{ seq: string; reason: string }>(
      'SELECT seq, reason FROM commit_tombstones WHERE doc_id = $1 ORDER BY seq',
      [doc],
    );
    expect(stones.rows.map((x) => [Number(x.seq), x.reason])).toEqual([
      [1, PARTICIPANT_ERASURE_REASON],
      [3, PARTICIPANT_ERASURE_REASON],
    ]);
    // The chain verifies as before and no metadata row changed.
    expect(await logs.verify(ref(doc))).toEqual(verdictBefore);
    expect(
      (
        await h.db!.admin.query<{ t: string }>(
          'SELECT to_jsonb(c)::text AS t FROM doc_commits c WHERE doc_id = $1 ORDER BY seq',
          [doc],
        )
      ).rows.map((x) => x.t),
    ).toEqual(metaBefore);

    // Criterion 4: one entry for the erasure, with counts only (no participant, surrogate or seq).
    const entries = await h.parts.audit!.query(h.tenant, { kind: 'evidence.erased', limit: 10 });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      doc,
      actor: 'system',
      data: { removedCount: 2, tombstonedCount: 2 },
    });
    const text = JSON.stringify(entries[0]);
    for (const secret of ['p-bob', bob, '203.0.113.7', 'Test agent'])
      expect(text).not.toContain(secret);
    // The tombstones' own audit entries name the commits and the fixed reason, not the person.
    const stoneEntries = await h.parts.audit!.query(h.tenant, {
      kind: 'commit.tombstoned',
      limit: 10,
    });
    expect(stoneEntries.map((e) => e.data)).toEqual([
      { seq: 1, reason: PARTICIPANT_ERASURE_REASON },
      { seq: 3, reason: PARTICIPANT_ERASURE_REASON },
    ]);
    expect(JSON.stringify(stoneEntries)).not.toContain(bob);

    // A second erasure finds nothing left and does no harm.
    expect(
      await eraseParticipant(deps, { ref: ref(doc), participant: 'p-bob', actor: 'system' }),
    ).toEqual({ evidenceRows: 0, tombstones: 0, checkpointCopies: [] });
  }, 60_000);

  it('erases a participant who has no commits, or no known surrogate, by their rows alone', async () => {
    const d = await documentWithFills('Rows only', true);
    await evidenceFor(d);
    const ledger = new PgEvidenceLedger(h.db!.service, { now: () => h.now() });
    await ledger.record(h.tenant, {
      doc: d,
      participant: 'p-stranger',
      kind: 'signer',
      item: 'viewed',
      facts: { items: { session: 's' }, ipAddress: null, userAgent: null },
    });
    const out = await eraseParticipant(deps, {
      ref: ref(d),
      participant: 'p-stranger',
      actor: 'system',
    });
    expect(out).toEqual({ evidenceRows: 1, tombstones: 0, checkpointCopies: [] });
    expect(await payloadSeqs(d)).toEqual([1, 2, 3, 4]);
    expect(await evidenceCount(d, 'p-bob')).toBe(2);
  }, 60_000);
});
