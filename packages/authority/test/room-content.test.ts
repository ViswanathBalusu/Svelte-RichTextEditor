// Content at any sequence number (08 §3; HIS-005; SYN-029 criterion 5): from the nearest
// checkpoint or a snapshot's checkpoint plus a replay, behind the visibility gate, cached by
// incarnation and seq, and runnable in a worker thread on plain data.
import { Worker } from 'node:worker_threads';
import { canonicalNodeText, sha256Hex, type JsonNode } from '@docedit/model';
import fc from 'fast-check';
import type { Node } from 'prosemirror-model';
import { Fragment, Slice } from 'prosemirror-model';
import { ReplaceStep, Transform } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import {
  ContentCache,
  type Checkpoint,
  type ContentSource,
  contentAt,
  contentEtag,
  defaultReplayers,
  replayerKey,
} from '../src/room/content.ts';
import { minVisibleSeq } from '../src/room/gate.ts';
import {
  ENGINE,
  type LogCommit,
  type SnapshotCommit,
  type StoredCommit,
} from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import { baseDoc, posInside, schema } from './fixtures.ts';

const hash = (doc: Node) => sha256Hex(canonicalNodeText(doc.toJSON() as JsonNode));

let counter = 0;
const id = () => `0192f0c4-7b1e-7000-8000-${(++counter).toString(16).padStart(12, '0')}`;

/** A log of `n` typing commits, with a snapshot commit at the given sequence numbers. */
function makeLog(n: number, snapshotsAt: readonly number[] = []) {
  let doc = baseDoc();
  const docs: Node[] = [doc];
  const log: LogCommit[] = [];
  const objects = new Map<string, Node>();
  for (let seq = 1; seq <= n; seq++) {
    const base = {
      seq,
      id: id(),
      user: 'alice',
      session: 's-alice',
      time: 1_000 + seq,
      scopes: ['body'],
      revision: 1,
      cdm: 1,
      engine: ENGINE,
      retired: [],
      claimed: [],
    };
    if (snapshotsAt.includes(seq)) {
      const at = posInside(baseDoc(), 'pIntro0000000001');
      doc = new Transform(baseDoc()).insert(at, schema.text(`snapshot ${seq} `)).doc;
      objects.set(`ckpt-${seq}`, doc);
      log.push({
        ...base,
        kind: 'snapshot',
        steps: [],
        snapshot: { checkpoint: `ckpt-${seq}`, reason: 'restore' },
        origin: 'restore',
      } satisfies SnapshotCommit);
    } else {
      const at = posInside(doc, 'pIntro0000000001');
      const step = new ReplaceStep(at, at, new Slice(Fragment.from(schema.text(`${seq}`)), 0, 0));
      doc = step.apply(doc).doc!;
      log.push({
        ...base,
        kind: 'steps',
        steps: stepsToJson([step]),
        origin: 'input',
      } satisfies StoredCommit);
    }
    docs.push(doc);
  }
  return { log, docs, objects };
}

function source(
  made: ReturnType<typeof makeLog>,
  checkpointSeqs: readonly number[],
  extra: Partial<ContentSource> = {},
): ContentSource {
  const checkpoints: Checkpoint[] = [0, ...checkpointSeqs].map((seq) => ({
    seq,
    doc: made.docs[seq]!,
  }));
  return {
    incarnation: 'inc-1',
    head: made.log.length,
    checkpoints,
    commits: (after, to) => made.log.filter((c) => c.seq > after && c.seq <= to),
    resolve: (c) => made.objects.get(c.snapshot.checkpoint)!,
    replayers: defaultReplayers(schema),
    ...extra,
  };
}

describe('content at a sequence number (HIS-005)', () => {
  it('starts from the nearest checkpoint at or before the seq and replays the commits after it', () => {
    const made = makeLog(10);
    const r = contentAt(7, source(made, [3, 5, 9]));
    expect(r.ok && [r.from, r.replayed]).toEqual([{ seq: 5, kind: 'checkpoint' }, 2]);
    expect(r.ok && r.doc.eq(made.docs[7]!)).toBe(true);
    expect(contentAt(11, source(made, [])).ok).toBe(false);
  });

  it('gives the hash of a full replay from any checkpoint at or before the seq (property)', async () => {
    const made = makeLog(24, [9, 17]);
    const cases = fc.sample(
      fc.record({
        seq: fc.integer({ min: 0, max: 24 }),
        checkpoints: fc.uniqueArray(fc.integer({ min: 1, max: 24 }), { maxLength: 6 }),
      }),
      { numRuns: 200, seed: 5 },
    );
    for (const c of cases) {
      const full = contentAt(c.seq, source(made, []));
      const near = contentAt(c.seq, source(made, c.checkpoints));
      expect(full.ok && near.ok).toBe(true);
      if (full.ok && near.ok) expect(await hash(near.doc)).toBe(await hash(full.doc));
      if (near.ok) expect(near.doc.eq(made.docs[c.seq]!)).toBe(true);
    }
  });

  it('starts from the snapshot commit checkpoint when the replay would cross one', () => {
    const made = makeLog(12, [6]);
    let resolved = 0;
    const src = source(made, [2], {
      resolve: (c) => {
        resolved++;
        return made.objects.get(c.snapshot.checkpoint)!;
      },
    });
    const r = contentAt(9, src);
    expect(r.ok && [r.from, r.replayed]).toEqual([{ seq: 6, kind: 'snapshot' }, 3]);
    expect(r.ok && r.doc.eq(made.docs[9]!)).toBe(true);
    // The pinned read at the snapshot itself comes from its checkpoint (SYN-005 criterion 5).
    const at = contentAt(6, src);
    expect(at.ok && [at.from, at.replayed]).toEqual([{ seq: 6, kind: 'snapshot' }, 0]);
    expect(resolved).toBe(2);
  });

  it('replays each commit with the package of its engine and CDM version (HIS-045 decides how long one is kept)', () => {
    const made = makeLog(4);
    const old = made.log[1] as StoredCommit;
    made.log[1] = { ...old, engine: 'pm-steps/0', cdm: 0 };
    expect(contentAt(4, source(made, []))).toMatchObject({
      ok: false,
      code: 'internal',
      reason: expect.stringMatching(/no replayer for engine pm-steps\/0 and CDM 0/),
    });
    // With the older package registered, its commits replay through it.
    const used: number[] = [];
    const replayers = defaultReplayers(schema);
    const current = replayers.get(replayerKey(ENGINE, 1))!;
    replayers.set(replayerKey('pm-steps/0', 0), (doc, c) => {
      used.push(c.seq);
      return current(doc, c);
    });
    const r = contentAt(4, source(made, [], { replayers }));
    expect(r.ok && r.doc.eq(made.docs[4]!)).toBe(true);
    expect(used).toEqual([2]);
  });

  it('refuses a seq below the visibility gate before any rebuild work', () => {
    const made = makeLog(5);
    let work = 0;
    const src = source(made, [], {
      commits: (after, to) => {
        work++;
        return made.log.filter((c) => c.seq > after && c.seq <= to);
      },
    });
    const min = minVisibleSeq({
      setting: 'editors',
      editsSomewhere: false,
      head: 5,
      timeOf: () => 0,
    });
    expect(contentAt(2, src, { min })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(work).toBe(0);
    // The head is never blocked; a named version is visible on its own (phase 2).
    expect(contentAt(5, src, { min }).ok).toBe(true);
    expect(contentAt(3, src, { min, named: (s) => s === 3 }).ok).toBe(true);
  });

  it('caches pinned reads by incarnation and seq, with an entity tag that combines both', () => {
    const made = makeLog(6);
    const cache = new ContentCache(2);
    const a = cache.read(4, source(made, []));
    const b = cache.read(4, source(made, []));
    expect(a.ok && b.ok && a.doc === b.doc).toBe(true);
    expect(cache.read(4, source(made, [], { incarnation: 'inc-2' })).ok).toBe(true);
    expect(cache.size).toBe(2);
    expect(cache.get('inc-1', 4)).toBe(a.ok ? a.doc : undefined);
    expect(cache.get('inc-2', 3)).toBeUndefined();
    expect(contentEtag('inc-1', 4)).toBe('"inc-1:4"');
    expect(contentEtag('inc-1', 4)).not.toBe(contentEtag('inc-2', 4));
    // The gate applies to cached reads too.
    expect(cache.read(4, source(made, []), { min: 6 })).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
  });

  it('runs in a worker thread with plain data and none of the room (SYN-039)', async () => {
    const made = makeLog(9, [4]);
    const workerData = {
      seq: 8,
      head: 9,
      incarnation: 'inc-1',
      checkpoints: [
        { seq: 0, doc: baseDoc().toJSON() },
        { seq: 2, doc: made.docs[2]!.toJSON() },
      ],
      log: JSON.parse(JSON.stringify(made.log)) as LogCommit[],
      objects: Object.fromEntries([...made.objects].map(([k, v]) => [k, v.toJSON()])),
    };
    const result = await new Promise<{ ok: boolean; text?: string; replayed?: number }>(
      (resolve, reject) => {
        const w = new Worker(new URL('./harness/content-worker.ts', import.meta.url), {
          workerData,
        });
        w.once('message', resolve);
        w.once('error', reject);
      },
    );
    expect(result.ok).toBe(true);
    expect(result.text).toBe(canonicalNodeText(made.docs[8]!.toJSON() as JsonNode));
    expect(result.replayed).toBe(4);
  });
});
