// U-HIS-001-016 lane. HIS-001 (every field of a commit of each kind is recorded, criteria 1 and 2),
// HIS-002 (control and snapshot commits are chained, criterion 4) and HIS-016 (who filled a field
// is answered by PgLogStore.scopeHistory, an index lookup on commit_scopes, criterion 5), against
// PostgreSQL. Each run creates its own
// database through the test support and drops it afterwards.
import { createHash } from 'node:crypto';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import type { LogCommit, SnapshotCommit, StoredCommit } from '@docedit/authority';
import { canonicalize, uuid7 } from '@docedit/model';
import type { JsonEnvelope } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PgLogStore } from '../../src/index.ts';
import { beginForTenant } from '../../src/storage/db.ts';
import { SELECT_SCOPE_HISTORY } from '../../src/storage/log-store.ts';
import {
  controlCommit,
  newDocument,
  stepCommit,
  TERMS,
  write,
  type StoreHarness,
} from '../contract/checks.ts';
import {
  createTestDatabase,
  newTenant,
  pgStores,
  postgresUnavailable,
  type TestDatabase,
} from '../support/env.ts';

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

/** A snapshot commit at `seq` and its content, built the way the room encodes one (BE-037). */
function snapshotRequest(seq: number, revision: number, marker: string) {
  const envelope: JsonEnvelope = {
    cdm: 1,
    requires: ['fields'],
    doc: {
      type: 'doc',
      content: [{ type: 'body', content: [{ type: 'paragraph', text: marker }] }],
    },
  } as unknown as JsonEnvelope;
  const text = canonicalize(envelope);
  const hash = createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
  const commit: SnapshotCommit = {
    seq,
    id: uuid7(),
    kind: 'snapshot',
    steps: [],
    snapshot: { checkpoint: `sha256:${hash}`, reason: 'restore' },
    user: 'system',
    session: 'system',
    time: 1_760_000_500_000 + seq,
    origin: 'restore',
    scopes: [],
    revision,
    cdm: 1,
    engine: 'pm-steps/1',
    retired: [],
    claimed: [],
  };
  return {
    commit,
    options: {
      snapshot: {
        envelope,
        encoded: zstdCompressSync(Buffer.from(text, 'utf8')),
        hash,
      },
    },
    text,
  };
}

describe.skipIf(unavailable !== null)('U-HIS-001-016: the history record in PostgreSQL', () => {
  let db: TestDatabase;
  let h: StoreHarness;
  beforeAll(async () => {
    db = await createTestDatabase();
    const s = pgStores(db.service);
    h = {
      tenant: newTenant(),
      otherTenant: newTenant(),
      docs: s.docs,
      logs: s.logs,
      grants: s.grants,
    };
  });
  afterAll(() => db?.drop());

  it('HIS-001 criteria 1 and 2: reads back every recorded field of a steps, a control and a snapshot commit', async () => {
    const { ref, epoch } = await newDocument(h);
    const logs = h.logs as PgLogStore;

    // A rebased steps commit, with the base, the token jti and the assistant that acted.
    const steps: StoredCommit = stepCommit(1, {
      id: uuid7(),
      user: 'alice',
      session: 's-alice-1',
      agent: 'agent-drafter',
      origin: 'input',
      scopes: ['body', `region:${TERMS}`, 'field:f-amount'],
      base: 0,
      rebased: true,
      jti: 'jti-u-his-001-016-1',
      revision: 1,
      cdm: 1,
      engine: 'pm-steps/1',
    });
    const control = controlCommit(2, 1);
    const snap = snapshotRequest(3, 1, 'restored text');

    expect(await logs.append(ref, write(epoch, [steps, control]))).toEqual({ status: 'ok' });
    expect(
      await logs.append(
        ref,
        { epoch, revision: 1, fromSeq: 3, commits: [], snapshot: snap.commit },
        snap.options,
      ),
    ).toEqual({ status: 'ok' });

    // The typed read gives back the commit of each kind as it was accepted.
    const back = await logs.read(ref);
    expect(back).toHaveLength(3);
    const byKind = (k: LogCommit['kind']) => back.find((c) => c.kind === k)!;
    const got = byKind('steps') as StoredCommit;
    expect(got.seq).toBe(1);
    expect(got.id).toBe(steps.id);
    expect(got.user).toBe('alice');
    expect(got.session).toBe('s-alice-1');
    expect(got.agent).toBe('agent-drafter');
    expect(got.origin).toBe('input');
    expect(got.scopes.slice().sort()).toEqual(['body', 'field:f-amount', `region:${TERMS}`].sort());
    expect(got.base).toBe(0);
    expect(got.rebased).toBe(true);
    expect(got.jti).toBe('jti-u-his-001-016-1');
    expect(got.revision).toBe(1);
    expect(got.cdm).toBe(1);
    expect(got.engine).toBe('pm-steps/1');
    expect(got.steps).toEqual(steps.steps);
    expect(got.time).toBe(steps.time);

    const ctl = byKind('control') as StoredCommit;
    expect(ctl.seq).toBe(2);
    expect(ctl.id).toBe(control.id);
    expect(ctl.user).toBe('system');
    expect(ctl.origin).toBe('control');
    expect(ctl.steps).toEqual([]);

    const snapBack = byKind('snapshot') as SnapshotCommit;
    expect(snapBack.seq).toBe(3);
    expect(snapBack.id).toBe(snap.commit.id);
    expect(snapBack.origin).toBe('restore');
    expect(snapBack.user).toBe('system');
    expect(snapBack.snapshot).toEqual(snap.commit.snapshot);
    expect(await logs.snapshotContent!(ref, 3)).toEqual(snap.options.snapshot.envelope);

    // The columns the typed read does not expose: the size and the payload, and the payload hash.
    const rows = (
      await db.admin.query<{
        seq: string;
        kind: string;
        size: number;
        payload: Buffer;
        payload_hash: Buffer;
        hash: Buffer;
        server_ts: Date;
        cdm_version: number;
        engine: string;
        access_rev: string;
        token_jti: string | null;
        base: string | null;
        rebased: boolean | null;
      }>(
        `SELECT c.seq, c.kind, c.size, p.payload, c.payload_hash, c.hash, c.server_ts, c.cdm_version,
                c.engine, c.access_rev, c.token_jti, c.base, c.rebased
           FROM doc_commits c LEFT JOIN doc_commit_payloads p USING (doc_id, seq)
          WHERE c.doc_id = $1 ORDER BY c.seq`,
        [ref.doc],
      )
    ).rows;
    expect(rows.map((r) => r.kind)).toEqual(['steps', 'control', 'snapshot']);
    const sRow = rows[0]!;
    expect(sRow.server_ts).toBeInstanceOf(Date);
    expect(sRow.cdm_version).toBe(1);
    expect(sRow.engine).toBe('pm-steps/1');
    expect(sRow.access_rev).toBeTruthy();
    expect(sRow.token_jti).toBe('jti-u-his-001-016-1');
    expect(Number(sRow.base)).toBe(0);
    expect(sRow.rebased).toBe(true);
    expect(sRow.size).toBeGreaterThan(0);
    expect(sRow.payload_hash.length).toBe(32);
    expect(sRow.hash.length).toBe(32);
    // The payload is the steps as applied, canonical and compressed.
    expect(JSON.parse(zstdDecompressSync(sRow.payload).toString('utf8')).steps).toEqual(
      steps.steps,
    );
    // Each commit's size is the size of its stored record.
    for (const r of rows) expect(r.size).toBeGreaterThan(0);
    // A snapshot commit's payload is the checkpoint reference, not steps.
    const snapPayload = JSON.parse(zstdDecompressSync(rows[2]!.payload).toString('utf8'));
    expect(snapPayload.snapshot ?? snapPayload).toMatchObject({
      checkpoint: snap.commit.snapshot.checkpoint,
    });
    expect(snap.text.length).toBeGreaterThan(0);
  });

  it('HIS-002 criterion 4: control and snapshot commits are chained in the same way as step commits', async () => {
    const { ref, epoch } = await newDocument(h);
    const logs = h.logs as PgLogStore;
    await logs.append(ref, write(epoch, [stepCommit(1), stepCommit(2)]));
    await logs.append(ref, write(epoch, [controlCommit(3, 1)]));
    const snap = snapshotRequest(4, 1, 'chain check');
    await logs.append(
      ref,
      { epoch, revision: 1, fromSeq: 4, commits: [], snapshot: snap.commit },
      snap.options,
    );
    await logs.append(ref, write(epoch, [stepCommit(5)]));
    expect(await logs.verify(ref)).toEqual({ ok: true, head: 5 });

    // The hashes of the control and snapshot rows link to the row before them, like step rows do.
    const rows = (
      await db.admin.query<{ seq: string; kind: string; prev_hash: Buffer | null; hash: Buffer }>(
        'SELECT seq, kind, prev_hash, hash FROM doc_commits WHERE doc_id = $1 ORDER BY seq',
        [ref.doc],
      )
    ).rows;
    expect(rows.map((r) => r.kind)).toEqual(['steps', 'steps', 'control', 'snapshot', 'steps']);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.prev_hash!.equals(rows[i - 1]!.hash)).toBe(true);
    }
  });

  it('HIS-016 criterion 5: scopeHistory answers a field lookup from the commit_scopes index, not by replaying the log', async () => {
    const logs = h.logs as PgLogStore;
    // Two documents of 600 commits each. Every commit changes the body and one of 30 fields, and
    // every 50th commit (seq 7, 57, 107, ...) also fills `f-owner`, so the lookup selects 12 of
    // about 2,400 scope rows. The planner chooses its plan from statistics (ANALYZE below); no
    // planner setting is changed.
    const COMMITS = 600;
    const BATCH = 100;
    const owner = (seq: number) => seq % 50 === 7;
    const docs: Awaited<ReturnType<typeof newDocument>>[] = [];
    for (let d = 0; d < 2; d++) {
      const nd = await newDocument(h);
      docs.push(nd);
      for (let from = 1; from <= COMMITS; from += BATCH) {
        const batch: StoredCommit[] = [];
        for (let seq = from; seq < from + BATCH; seq++) {
          const scopes = ['body', `field:f-${seq % 30}`];
          if (owner(seq)) scopes.push('field:f-owner');
          batch.push(
            stepCommit(seq, {
              scopes,
              user: owner(seq) ? `owner-${seq}` : 'alice',
              session: `s-${seq}`,
              origin: owner(seq) && seq % 100 === 7 ? 'prefill' : 'input',
            }),
          );
        }
        expect(await logs.append(nd.ref, write(nd.epoch, batch))).toEqual({ status: 'ok' });
      }
    }
    await db.admin.query('ANALYZE commit_scopes');
    await db.admin.query('ANALYZE doc_commits');
    const { ref } = docs[0]!;
    const expected = Array.from({ length: COMMITS }, (_, i) => i + 1)
      .filter(owner)
      .reverse();

    // The product method: every commit that touched the field, newest first, with its metadata.
    const all = await logs.scopeHistory(ref, 'field:f-owner');
    expect(all.map((e) => e.seq)).toEqual(expected);
    for (const e of all) {
      expect(e.user).toBe(`owner-${e.seq}`);
      expect(e.session).toBe(`s-${e.seq}`);
      expect(e.origin).toBe(e.seq % 100 === 7 ? 'prefill' : 'input');
      expect(e.kind).toBe('steps');
      expect(typeof e.time).toBe('number');
      expect(e.scopes).toContain('field:f-owner');
    }
    // The gate: commits at or below `after` and above `upTo` are withheld.
    const gated = await logs.scopeHistory(ref, 'field:f-owner', { after: 107, upTo: 407 });
    expect(gated.map((e) => e.seq)).toEqual([407, 357, 307, 257, 207, 157]);
    // A field that never changed has an empty history.
    expect(await logs.scopeHistory(ref, 'field:never')).toEqual([]);

    // The plan of the method's own statement, as the service role runs it inside the tenant.
    const client = await db.service.connect();
    let plan: unknown;
    try {
      await beginForTenant(client, ref.tenant, { readOnly: true });
      const [row] = (
        await client.query<{ 'QUERY PLAN': unknown }>(
          `EXPLAIN (FORMAT JSON) ${SELECT_SCOPE_HISTORY}`,
          [ref.doc, 'field:f-owner', 0, null],
        )
      ).rows;
      plan = row!['QUERY PLAN'];
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
    type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };
    const nodes: PlanNode[] = [];
    const walk = (n: PlanNode) => {
      nodes.push(n);
      for (const k of n.Plans ?? []) walk(k);
    };
    walk((plan as Array<{ Plan: PlanNode }>)[0]!.Plan);
    const text = JSON.stringify(plan);
    // The scope rows are found through the primary key (doc_id, scope, seq).
    const scopeScan = nodes.find((n) => n['Alias'] === 'f');
    expect(scopeScan?.['Node Type']).toMatch(/^Index (Only )?Scan$/);
    expect(scopeScan?.['Index Name']).toBe('commit_scopes_pkey');
    expect(String(scopeScan?.['Index Cond'])).toContain('scope');
    // Each commit row is read by its key, in one partition; no table is scanned in full.
    const commitScan = nodes.find((n) => n['Alias'] === 'k');
    expect(commitScan?.['Node Type']).toMatch(/^Index (Only )?Scan$/);
    expect(String(commitScan?.['Index Name'])).toMatch(/^doc_commits_p\d+_pkey$/);
    expect(nodes.filter((n) => n['Node Type'] === 'Seq Scan')).toEqual([]);
    // No payload is read.
    expect(text).not.toContain('doc_commit_payloads');
  }, 120_000);
});
