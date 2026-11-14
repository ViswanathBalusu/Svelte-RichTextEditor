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
import { MemoryObjectStore } from '../objects/store.ts';
import type { MemoryStore } from '../storage/memory.ts';
import { MemoryAudit, MemoryCheckpointIndex } from './memory-ports.ts';
import {
  affectedAmong,
  beyondHead,
  contentHash,
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
