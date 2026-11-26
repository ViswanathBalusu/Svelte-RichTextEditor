/**
 * Recovery by evidence (BE-078, BE-081; 06 §8, §9, §11). The functions in `recovery.ts` run on the
 * stores alone: these tests write commits through the real data plane, then close the plane and
 * work from the stores (the in-memory log, checkpoints, index and audit) as an operator would from
 * a restored database. The `incarnation` command's procedure (`runIncarnation`) is tested with the
 * selection for stores without an index (`affectedAmong`); the command-line wrapper
 * (`recovery-cli.ts`) and the PostgreSQL-only `affected` query are not run here (they need a
 * database and a process exit code).
 */
import type { JsonEnvelope } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { insertText } from '../../test/data-plane/client.ts';
import { BASE_JSON, REQUIRES, startPlane, type Plane } from '../../test/data-plane/support.ts';
import { ObjectCheckpointStore } from '../objects/checkpoints.ts';
import { ObjectSegmentStore, parseSegmentKey } from '../objects/segments.ts';
import { MemoryObjectStore, objectKeys } from '../objects/store.ts';
import type { MemoryStore } from '../storage/memory.ts';
import { MemoryAudit, MemoryCheckpointIndex } from './memory-ports.ts';
import { Metrics } from './metrics.ts';
import {
  affectedAmong,
  beyondHead,
  contentHash,
  gateThinning,
  newIncarnation,
  rebuild,
  runIncarnation,
  verifyCheckpoint,
  type RecoveryStores,
} from './recovery.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');

/** The memory log, typed as the incarnation procedure takes it (BE-078). */
const logsOf = (p: Plane) => p.stores.logs as Parameters<typeof newIncarnation>[0]['logs'];

let planes: Plane[] = [];
async function plane(...args: Parameters<typeof startPlane>): Promise<Plane> {
  const p = await startPlane(...args);
  planes.push(p);
  return p;
}
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

/** Alice writes `n` commits through the data plane; the room is open while she does. */
async function writeCommits(p: Plane, doc: string, n: number): Promise<void> {
  const a = await p.client('alice', { [doc]: 'owner' });
  await a.open(1, doc);
  for (let i = 0; i < n; i++) {
    const r = await a.submit(1, { base: i, steps: [insertText(intro(), `t${i}`)] });
    expect(r.t).toBe('sync.ack');
  }
}

describe('rebuild and verify from a checkpoint and the log (BE-081)', () => {
  it('rebuilds the head and any earlier seq to a hash, from the stores alone', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const ref = p.ref(doc);
    await writeCommits(p, doc, 3);
    // The service goes away; the stores are all the operator has.
    await p.close();
    planes = [];
    const stores: RecoveryStores = { logs: p.stores.logs, checkpoints: p.checkpoints };

    const head = await rebuild(stores, ref);
    expect(head.seq).toBe(3);
    expect(head.hash).toMatch(/^[0-9a-f]{64}$/);
    // The same seq asked explicitly gives the same hash; an earlier seq gives another one.
    expect((await rebuild(stores, ref, 3)).hash).toBe(head.hash);
    const earlier = await rebuild(stores, ref, 1);
    expect(earlier.seq).toBe(1);
    expect(earlier.hash).not.toBe(head.hash);
    // A seq above the head is refused, not invented.
    await expect(rebuild(stores, ref, 4)).rejects.toThrow(RangeError);
  });

  it('reports a stored checkpoint that differs from the replay, and accepts one that matches', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const ref = p.ref(doc);
    await writeCommits(p, doc, 3);
    const stores: RecoveryStores = { logs: p.stores.logs, checkpoints: p.checkpoints };

    // A checkpoint at 3 holding the content of seq 2 (wrong) is reported as a mismatch.
    const base = (await p.checkpoints.get(ref, 0)) as JsonEnvelope;
    await p.checkpoints.put(ref, 3, base);
    const wrong = await verifyCheckpoint(stores, ref, 3);
    expect(wrong.ok).toBe(false);
    expect(wrong.stored).not.toBe(wrong.replayed);
    expect(wrong.from).toBe(0);

    // The checkpoint at 3 built from the replay itself verifies.
    const seq3 = await p.plane.readContent(
      p.tokens.identity(p.tokens.issue({ user: 'alice', docs: { [doc]: 'owner' } })),
      doc,
      3,
    );
    const correct: JsonEnvelope = {
      cdm: 1,
      requires: REQUIRES,
      doc: seq3.doc as JsonEnvelope['doc'],
    };
    await p.checkpoints.put(ref, 3, correct);
    const right = await verifyCheckpoint(stores, ref, 3);
    expect(right.ok).toBe(true);
    expect(contentHash(correct)).toBe(right.stored);
  });
});

describe('the gate before checkpoints are thinned (BE-020 criterion 5)', () => {
  it('lets thinning proceed on a match and stops it, with an alert, on a mismatch', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const ref = p.ref(doc);
    await writeCommits(p, doc, 3);
    const stores: RecoveryStores = { logs: p.stores.logs, checkpoints: p.checkpoints };
    const metrics = new Metrics('test-node');
    const alerts: Array<{ seq: number; doc: string }> = [];
    const alert = (v: { seq: number }, r: { doc: string }) => {
      alerts.push({ seq: v.seq, doc: r.doc });
      metrics.checkpointMismatches.inc({ tenant: ref.tenant });
    };

    // A checkpoint at 3 built from the replay: thinning may proceed and nothing is raised.
    const seq3 = await p.plane.readContent(
      p.tokens.identity(p.tokens.issue({ user: 'alice', docs: { [doc]: 'owner' } })),
      doc,
      3,
    );
    await p.checkpoints.put(ref, 3, {
      cdm: 1,
      requires: REQUIRES,
      doc: seq3.doc as JsonEnvelope['doc'],
    });
    const good = await gateThinning(stores, ref, 3, alert);
    expect(good.proceed).toBe(true);
    expect(alerts).toEqual([]);
    expect(metrics.checkpointMismatches.get({ tenant: ref.tenant })).toBe(0);

    // A checkpoint at 3 that holds the content of seq 0: thinning stops and an alert is raised.
    await p.checkpoints.put(ref, 3, (await p.checkpoints.get(ref, 0)) as JsonEnvelope);
    const bad = await gateThinning(stores, ref, 3, alert);
    expect(bad.proceed).toBe(false);
    expect(bad.verdict.stored).not.toBe(bad.verdict.replayed);
    expect(alerts).toEqual([{ seq: 3, doc }]);
    expect(metrics.checkpointMismatches.get({ tenant: ref.tenant })).toBe(1);
    expect(metrics.text()).toContain('dep_checkpoint_mismatches_total');

    // A checkpoint that is not there cannot be verified, so nothing is thinned for it.
    await expect(gateThinning(stores, ref, 9, alert)).rejects.toThrow('no checkpoint at 9');
  });
});

describe('new incarnation after a database recovery (BE-078)', () => {
  it('gives the document a new incarnation, sets aside checkpoints past the head, and audits it', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const ref = p.ref(doc);
    await writeCommits(p, doc, 3);
    const index = new MemoryCheckpointIndex();
    const audit = new MemoryAudit();
    // A checkpoint past the head, as a restore to an earlier point leaves behind.
    await index.record(ref, { seq: 5, key: 'k5', bytes: 1, hash: 'h5' });
    await p.checkpoints.put(ref, 5, {
      cdm: 1,
      requires: REQUIRES,
      doc: BASE_JSON as JsonEnvelope['doc'],
    });

    const before = (await p.stores.logs.head(ref)).incarnation;
    const change = await newIncarnation(
      { logs: logsOf(p), checkpoints: p.checkpoints, index, audit },
      ref,
      { actor: 'operator' },
    );
    expect(change.head).toBe(3);
    expect(change.before).toBe(before);
    expect(change.after).not.toBe(before);
    expect((await p.stores.logs.head(ref)).incarnation).toBe(change.after);
    expect(change.setAside).toEqual([5]);
    expect((await index.list(ref)).map((r) => r.seq)).not.toContain(5);

    const events = await audit.query(ref.tenant, { doc: ref.doc, limit: 10 });
    expect(events.map((e) => e.kind)).toContain('incarnation.changed');
  });

  it('selects only the documents whose checkpoints reach past the head, and leaves the others their incarnation', async () => {
    // Checkpoints in the object store (in memory), as the command reads them.
    const objects = new ObjectCheckpointStore(new MemoryObjectStore());
    const p = await plane({ deps: { checkpoints: objects } });
    const docs = [await p.createDocument(), await p.createDocument(), await p.createDocument()];
    const [rewound, behind, untouched] = docs as [string, string, string];
    const refs = docs.map((d) => p.ref(d));
    for (const ref of refs) await objects.put(ref, 0, (await p.checkpoints.get(ref, 0))!);
    for (const d of docs) await writeCommits(p, d, 3);
    await p.close();
    planes = [];

    const content: JsonEnvelope = {
      cdm: 1,
      requires: REQUIRES,
      doc: BASE_JSON as JsonEnvelope['doc'],
    };
    // `rewound`: a checkpoint at 3, and a database restored to seq 1.
    await objects.put(p.ref(rewound), 3, content);
    (p.stores.logs as MemoryStore).rewindForTest(p.ref(rewound), 1);
    // `behind`: a checkpoint at 2, below its head of 3. `untouched`: no checkpoint past its head.
    await objects.put(p.ref(behind), 2, content);

    const stores = { logs: logsOf(p), checkpoints: objects };
    const incarnations = () =>
      Promise.all(refs.map(async (r) => (await p.stores.logs.head(r)).incarnation));
    const before = await incarnations();

    const selected = await affectedAmong(stores, refs);
    expect(selected).toEqual([{ tenant: p.tenant, doc: rewound, head: 1, checkpoint: 3 }]);
    expect(await beyondHead(stores, p.ref(behind))).toBeNull();
    expect(await beyondHead(stores, p.ref(untouched))).toBeNull();

    // The dry run changes nothing, not even for the selected document.
    expect(await runIncarnation(stores, selected, { dryRun: true })).toEqual([]);
    expect(await incarnations()).toEqual(before);
    expect(await objects.get(p.ref(rewound), 3)).not.toBeNull();

    // The command changes exactly the selected document.
    const changes = await runIncarnation(stores, selected, { dryRun: false, actor: 'operator' });
    expect(changes.map((c) => c.ref.doc)).toEqual([rewound]);
    const after = await incarnations();
    expect(after[0]).toBe(changes[0]!.after);
    expect(after[0]).not.toBe(before[0]);
    expect(after.slice(1)).toEqual(before.slice(1));
    // The checkpoint past the head was moved out of the object store's checkpoints.
    expect(changes[0]!.setAside).toEqual([3]);
    expect(await objects.get(p.ref(rewound), 3)).toBeNull();
    expect(await objects.get(p.ref(behind), 2)).not.toBeNull();
    // Run again, the command finds nothing left to change.
    expect(await affectedAmong(stores, refs)).toEqual([]);
  });
});

describe('cold segments past the restored head (BE-078, HIS-029)', () => {
  it('lists the documents whose segments reach past the head, and sets only those segments aside', async () => {
    const store = new MemoryObjectStore();
    const objects = new ObjectCheckpointStore(store);
    const segments = new ObjectSegmentStore(store);
    const p = await plane({ deps: { checkpoints: objects } });
    const docs = [await p.createDocument(), await p.createDocument(), await p.createDocument()];
    const [rewound, whole, bare] = docs as [string, string, string];
    const refs = docs.map((d) => p.ref(d));
    for (const ref of refs) await objects.put(ref, 0, (await p.checkpoints.get(ref, 0))!);
    for (const d of docs) await writeCommits(p, d, 3);
    await p.close();
    planes = [];

    const put = (doc: string, from: number, to: number, text: string) =>
      store.put(objectKeys.segment(p.tenant, doc, from, to), new TextEncoder().encode(text));
    // `rewound`: the database is restored to seq 1; a segment of 1 to 1 was moved before that
    // point, and a segment of 1 to 3 was written after it.
    (p.stores.logs as MemoryStore).rewindForTest(p.ref(rewound), 1);
    await put(rewound, 1, 1, 'old');
    await put(rewound, 1, 3, 'newer');
    // `whole`: every segment ends at or below the head. `bare`: no segment.
    await put(whole, 1, 3, 'kept');

    const stores = { logs: logsOf(p), checkpoints: objects, segments };
    const incarnations = () =>
      Promise.all(refs.map(async (r) => (await p.stores.logs.head(r)).incarnation));
    const before = await incarnations();

    expect(parseSegmentKey(objectKeys.segment(p.tenant, whole, 1, 3))).toEqual({
      tenant: p.tenant,
      doc: whole,
      from: 1,
      to: 3,
    });
    expect(parseSegmentKey(objectKeys.checkpoint(p.tenant, whole, 3))).toBeNull();
    expect((await segments.documents()).map((r) => r.doc).sort()).toEqual([rewound, whole].sort());

    const selected = await affectedAmong(stores, refs);
    expect(selected).toEqual([
      { tenant: p.tenant, doc: rewound, head: 1, checkpoint: 3, segments: [{ from: 1, to: 3 }] },
    ]);

    // The dry run changes nothing.
    expect(await runIncarnation(stores, selected, { dryRun: true })).toEqual([]);
    expect(await store.exists(objectKeys.segment(p.tenant, rewound, 1, 3))).toBe(true);
    expect(await incarnations()).toEqual(before);

    const audit = new MemoryAudit();
    const [change] = await runIncarnation({ ...stores, audit }, selected, {
      dryRun: false,
      actor: 'operator',
    });
    expect(change!.segmentsSetAside).toEqual([{ from: 1, to: 3 }]);
    // The segment past the head left the segments prefix and is kept under `aside`.
    expect(await store.exists(objectKeys.segment(p.tenant, rewound, 1, 3))).toBe(false);
    const aside = (await store.list(`tenants/${p.tenant}/docs/${rewound}/aside/`)).filter((k) =>
      k.includes('/segments/'),
    );
    expect(aside).toHaveLength(1);
    expect(aside[0]).toMatch(/\/segments\/1-3\.payloads\.zst$/);
    expect(new TextDecoder().decode((await store.get(aside[0]!))!)).toBe('newer');
    // The segment at or below the head, and the other documents' segments, are untouched.
    expect(await store.exists(objectKeys.segment(p.tenant, rewound, 1, 1))).toBe(true);
    expect(await store.exists(objectKeys.segment(p.tenant, whole, 1, 3))).toBe(true);
    expect(await store.list(objectKeys.segments(p.tenant, bare))).toEqual([]);
    // A new incarnation, audited with the segments; the unselected documents keep theirs.
    const after = await incarnations();
    expect(after[0]).toBe(change!.after);
    expect(after.slice(1)).toEqual(before.slice(1));
    const events = await audit.query(p.tenant, { doc: rewound, limit: 10 });
    expect(events.find((e) => e.kind === 'incarnation.changed')?.data).toMatchObject({
      segments: [{ from: 1, to: 3 }],
    });
    // Run again, nothing is left to select.
    expect(await affectedAmong(stores, refs)).toEqual([]);
  });
});
