/**
 * HIS-014 criteria 1 and 4: the room host keeps the attribution map as commits are stored, saves it
 * with each checkpoint, and a room that opens from a checkpoint plus a replay holds the same map as
 * one that replayed the whole log (08 §7; ADR 0377). The real data plane runs over the in-memory
 * stores; the checkpoint store keeps side objects like the object-store one does.
 *
 * The expected map is built here, apart from the room, by applying the stored commits to the map of
 * the content at seq 0 with the functions of `@docedit/history`.
 */
import { AttributionMap, applyCommit, coversExactly } from '@docedit/history';
import type { JsonEnvelope } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { afterEach, describe, expect, it } from 'vitest';
import { BASE_JSON, baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { insertText } from '../../test/data-plane/client.ts';
import {
  MemoryCheckpoints,
  REQUIRES,
  startPlane,
  until,
  type Plane,
} from '../../test/data-plane/support.ts';
import { MemoryStore } from '../storage/memory.ts';
import type { DocRef } from '../storage/types.ts';
import { decodeContent, encodeContent } from '../storage/codec.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');
const schema = cdmSchema();

/** Checkpoints with side objects, as `ObjectCheckpointStore` keeps them. */
class WithSides extends MemoryCheckpoints {
  override readonly sides = new Map<string, Uint8Array>();
  /** The checkpoint seqs written above 0, in order. */
  readonly written: number[] = [];
  /** Writes no side object while true: a checkpoint from before ADR 0377. */
  legacy = false;
  override async put(ref: DocRef, seq: number, content: JsonEnvelope): Promise<void> {
    if (seq > 0) this.written.push(seq);
    return super.put(ref, seq, content);
  }
  override async putSide(ref: DocRef, seq: number, bytes: Uint8Array): Promise<void> {
    if (!this.legacy) this.sides.set(`${ref.doc}/${seq}`, bytes);
  }
  override async getSide(ref: DocRef, seq: number): Promise<Uint8Array | null> {
    return this.sides.get(`${ref.doc}/${seq}`) ?? null;
  }
}

interface Durable {
  tenant: string;
  memory: MemoryStore;
  checkpoints: WithSides;
  viewKey: Uint8Array;
}

function durable(): Durable {
  return {
    tenant: crypto.randomUUID(),
    memory: new MemoryStore(),
    checkpoints: new WithSides(),
    viewKey: crypto.getRandomValues(new Uint8Array(32)),
  };
}

let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

async function boot(d: Durable, node: string, every = 2): Promise<Plane> {
  const p = await startPlane({
    stores: { logs: d.memory, ownership: d.memory, grants: d.memory, documents: d.memory },
    checkpoints: d.checkpoints,
    tenant: d.tenant,
    node,
    settings: {
      testMode: true,
      viewKey: d.viewKey,
      checkpoint: { everyCommits: every, everyMs: 600_000, minIntervalMs: 0 },
    },
  });
  planes.push(p);
  return p;
}

/** The map the whole log gives, replayed here from the content at seq 0. */
async function wholeLogMap(d: Durable, ref: DocRef, createdBy: string): Promise<AttributionMap> {
  const first = schema.nodeFromJSON(BASE_JSON);
  const map = AttributionMap.create(first.content.size, { user: createdBy, seq: 0 });
  for (const c of await d.memory.read(ref, 1)) applyCommit(map, c, schema);
  return map;
}

/** Stores `n` commits that insert text, and returns the client. */
async function commits(p: Plane, doc: string, user: 'alice' | 'bob', from: number, n: number) {
  const c = await p.client(user, { [doc]: 'owner' });
  expect((await c.open(1, doc)).t).toBe('ch.opened');
  for (let i = 0; i < n; i++) {
    const r = await c.submit(1, { base: from + i, steps: [insertText(intro(), `${user}${i} `)] });
    expect(r.t).toBe('sync.ack');
  }
  return c;
}

describe('the room keeps the attribution map (HIS-014 criterion 1)', () => {
  it('maps the runs through each stored commit and gives inserted text a run of its user and seq', async () => {
    const d = durable();
    const p = await boot(d, 'node-a', 2000);
    const doc = await p.createDocument();
    const ref = p.ref(doc);
    await commits(p, doc, 'alice', 0, 2);
    const room = p.plane.host.rooms[0]!;
    await until(() => room.attribution?.seq === 2, 3000, 'the map at the head');

    const stored = await d.memory.read(ref, 1);
    const runs = room.attribution!.snapshot().runs();
    // Two inserted stretches, one per commit, named with the commit's user and seq; the rest is the
    // content created at seq 0.
    // Each insert goes to the same place, so the newer text comes first.
    const inserted = runs.filter((r) => r.seq > 0).sort((x, y) => x.seq - y.seq);
    expect(inserted.map((r) => [r.user, r.seq])).toEqual(stored.map((c) => [c.user, c.seq]));
    expect(inserted.map((r) => r.len)).toEqual(['alice0 '.length, 'alice1 '.length]);
    expect(room.attribution!.snapshot().equals(await wholeLogMap(d, ref, 'alice'))).toBe(true);
    const full = schema.nodeFromJSON(
      (
        await p.plane.readContent(
          p.tokens.identity((await p.client('alice', { [doc]: 'owner' })).token!),
          doc,
        )
      ).doc,
    );
    expect(coversExactly(room.attribution!.snapshot(), full)).toBe(true);
  });

  it('names each person on what they inserted', async () => {
    const d = durable();
    const p = await boot(d, 'node-a', 2000);
    const doc = await p.createDocument();
    const ref = p.ref(doc);
    const a = await commits(p, doc, 'alice', 0, 1);
    const b = await p.client('bob', { [doc]: 'owner' });
    await b.open(1, doc);
    expect((await b.submit(1, { base: 1, steps: [insertText(intro(), 'bob ')] })).t).toBe(
      'sync.ack',
    );
    expect(a).toBeDefined();
    const room = p.plane.host.rooms[0]!;
    await until(() => room.attribution?.seq === 2, 3000, 'the map at the head');
    const stored = await d.memory.read(ref, 1);
    expect(stored[0]!.user).not.toBe(stored[1]!.user);
    const users = room
      .attribution!.snapshot()
      .runs()
      .filter((r) => r.seq > 0)
      .sort((x, y) => x.seq - y.seq)
      .map((r) => r.user);
    expect(users).toEqual(stored.map((c) => c.user));
  });

  it('replaces the map with one run of the snapshot commit user and seq', async () => {
    const d = durable();
    const p = await boot(d, 'node-a', 2000);
    const doc = await p.createDocument();
    await commits(p, doc, 'alice', 0, 1);
    const content = {
      cdm: 1,
      requires: [...REQUIRES],
      doc: structuredClone(BASE_JSON),
    } as unknown as JsonEnvelope;
    const { seq } = await p.plane.replaceContent(p.ref(doc), content, 'bob');
    const room = p.plane.host.rooms[0]!;
    await until(() => room.attribution?.seq === seq, 3000, 'the map after the snapshot');
    const runs = room.attribution!.snapshot().runs();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ seq, len: schema.nodeFromJSON(BASE_JSON).content.size });
    const [snap] = await d.memory.read(p.ref(doc), seq, seq);
    expect(runs[0]!.user).toBe(snap!.user);
  });
});

describe('the map is saved with each checkpoint (HIS-014 criterion 4)', () => {
  it('writes a side object with the checkpoint, holding the map at its seq', async () => {
    const d = durable();
    const p = await boot(d, 'node-a', 2);
    const doc = await p.createDocument();
    const ref = p.ref(doc);
    await commits(p, doc, 'alice', 0, 2);
    await until(() => d.checkpoints.written.includes(2), 3000, 'the checkpoint at 2');
    const bytes = d.checkpoints.sides.get(`${doc}/2`);
    expect(bytes).toBeDefined();
    const side = decodeContent<{
      v: number;
      attribution: Parameters<typeof AttributionMap.fromJSON>[0];
    }>(bytes!);
    expect(side.v).toBe(1);
    const saved = AttributionMap.fromJSON(side.attribution);
    expect(saved.equals(await wholeLogMap(d, ref, 'alice'))).toBe(true);
  });

  it('gives the map at the checkpoint seq when more commits are stored after it', async () => {
    const d = durable();
    const p = await boot(d, 'node-a', 2);
    const doc = await p.createDocument();
    const ref = p.ref(doc);
    await commits(p, doc, 'alice', 0, 3);
    await until(() => d.checkpoints.written.includes(2), 3000, 'the checkpoint at 2');
    const saved = AttributionMap.fromJSON(
      decodeContent<{ attribution: Parameters<typeof AttributionMap.fromJSON>[0] }>(
        d.checkpoints.sides.get(`${doc}/2`)!,
      ).attribution,
    );
    const first2 = AttributionMap.create(schema.nodeFromJSON(BASE_JSON).content.size, {
      user: 'alice',
      seq: 0,
    });
    for (const c of await d.memory.read(ref, 1, 2)) applyCommit(first2, c, schema);
    expect(saved.equals(first2)).toBe(true);
  });

  it('opens a room from a checkpoint plus a replay with the map the whole log gives', async () => {
    const d = durable();
    const a = await boot(d, 'node-a', 2);
    const doc = await a.createDocument();
    const ref = a.ref(doc);
    await commits(a, doc, 'alice', 0, 2);
    await until(() => d.checkpoints.written.includes(2), 3000, 'the checkpoint at 2');
    const b = await a.client('bob', { [doc]: 'owner' });
    await b.open(1, doc);
    expect((await b.submit(1, { base: 2, steps: [insertText(intro(), 'late ')] })).t).toBe(
      'sync.ack',
    );
    // A crash: no checkpoint at 3, so the next room opens from the one at 2 and replays commit 3.
    expect(await a.plane.hooks!.killRoom(ref)).toBe(true);
    expect(d.checkpoints.written).toEqual([2]);

    const n = await boot(d, 'node-b', 2000);
    const c = await n.client('alice', { [doc]: 'owner' });
    expect((await c.open(1, doc)).t).toBe('ch.opened');
    const room = n.plane.host.rooms[0]!;
    expect(room.attribution?.seq).toBe(3);
    expect(room.attribution!.snapshot().equals(await wholeLogMap(d, ref, 'alice'))).toBe(true);
  });

  it('rebuilds the map by one replay for a checkpoint written without one, and saves it with the next', async () => {
    const d = durable();
    d.checkpoints.legacy = true;
    const a = await boot(d, 'node-a', 2);
    const doc = await a.createDocument();
    const ref = a.ref(doc);
    await commits(a, doc, 'alice', 0, 2);
    await until(() => d.checkpoints.written.includes(2), 3000, 'the checkpoint at 2');
    expect(d.checkpoints.sides.size).toBe(0);
    expect(await a.plane.hooks!.killRoom(ref)).toBe(true);

    d.checkpoints.legacy = false;
    const n = await boot(d, 'node-b', 2);
    const c = await n.client('alice', { [doc]: 'owner' });
    expect((await c.open(1, doc)).t).toBe('ch.opened');
    const room = n.plane.host.rooms[0]!;
    expect(room.attribution?.seq).toBe(2);
    expect(room.attribution!.snapshot().equals(await wholeLogMap(d, ref, 'alice'))).toBe(true);
    // The next checkpoint saves it.
    for (let i = 0; i < 2; i++)
      expect((await c.submit(1, { base: 2 + i, steps: [insertText(intro(), 'x')] })).t).toBe(
        'sync.ack',
      );
    await until(() => d.checkpoints.sides.has(`${doc}/4`), 3000, 'the side object at 4');
    const saved = AttributionMap.fromJSON(
      decodeContent<{ attribution: Parameters<typeof AttributionMap.fromJSON>[0] }>(
        d.checkpoints.sides.get(`${doc}/4`)!,
      ).attribution,
    );
    expect(saved.equals(await wholeLogMap(d, ref, 'alice'))).toBe(true);
  });

  it('refuses a saved map that does not fit the content and replays instead', async () => {
    const d = durable();
    const a = await boot(d, 'node-a', 2);
    const doc = await a.createDocument();
    const ref = a.ref(doc);
    await commits(a, doc, 'alice', 0, 2);
    await until(() => d.checkpoints.written.includes(2), 3000, 'the checkpoint at 2');
    expect(await a.plane.hooks!.killRoom(ref)).toBe(true);
    // A damaged side object: a map for a document of the wrong size.
    d.checkpoints.sides.set(
      `${doc}/2`,
      encodeContent(
        JSON.stringify({
          v: 1,
          attribution: AttributionMap.create(3, { user: 'x', seq: 9 }).toJSON(),
        }),
      ),
    );
    const n = await boot(d, 'node-b', 2000);
    const c = await n.client('alice', { [doc]: 'owner' });
    expect((await c.open(1, doc)).t).toBe('ch.opened');
    const room = n.plane.host.rooms[0]!;
    expect(room.attribution!.snapshot().equals(await wholeLogMap(d, ref, 'alice'))).toBe(true);
  });
});
