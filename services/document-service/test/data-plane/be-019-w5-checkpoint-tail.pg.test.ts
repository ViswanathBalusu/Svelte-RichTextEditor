// A cold open starts from the latest checkpoint and replays only the log after it (06 §2.2 (1);
// BE-019 criterion 1). The room host is the real one with real WebSocket clients. The scenario runs
// over the in-memory stores and over the PostgreSQL stores; the checkpoint objects are in memory in
// both (the object store is BE-020's). The PostgreSQL part skips when PostgreSQL is not up:
// pwsh -NoProfile -File infra/test-env.ps1 up
import type { JsonEnvelope } from '@docedit/model';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import type { DocRef, LogStore } from '../../src/storage/types.ts';
import {
  createTestDatabase,
  pgStores,
  postgresUnavailable,
  type TestDatabase,
} from '../support/env.ts';
import { insertText } from './client.ts';
import {
  MemoryCheckpoints,
  memoryStores,
  startPlane,
  until,
  type Plane,
  type Stores,
} from './support.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');
const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

/** Checkpoints that record what is written and loaded, and can lose the content at 0. */
class Recording extends MemoryCheckpoints {
  readonly written: number[] = [];
  readonly loaded: number[] = [];
  /** When set, the content at sequence number 0 is gone: a room can only open from a later one. */
  hideZero = false;
  override async put(ref: DocRef, seq: number, content: JsonEnvelope): Promise<void> {
    this.written.push(seq);
    return super.put(ref, seq, content);
  }
  override async get(ref: DocRef, seq: number): Promise<JsonEnvelope | null> {
    if (seq === 0 && this.hideZero) return null;
    return super.get(ref, seq);
  }
  override async latest(ref: DocRef, atOrBefore: number) {
    const got = await super.latest(ref, atOrBefore);
    if (got) this.loaded.push(got.seq);
    return got;
  }
}

/** The log store, recording the range of every read. */
function recordingReads(inner: LogStore): { logs: LogStore; reads: [number, number | null][] } {
  const reads: [number, number | null][] = [];
  const logs = new Proxy(inner, {
    get(target, key) {
      if (key === 'read')
        return (ref: DocRef, fromSeq?: number, toSeq?: number) => {
          reads.push([fromSeq ?? 1, toSeq ?? null]);
          return target.read(ref, fromSeq, toSeq);
        };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  return { logs, reads };
}

function scenarios(makeStores: () => Stores): void {
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

  it('loads the checkpoint at seq 3 and replays only commits 4 and 5', async () => {
    const stores = makeStores();
    const spy = recordingReads(stores.logs);
    const checkpoints = new Recording();
    const shared = { ...stores, logs: spy.logs };
    const p = await plane({
      stores: shared,
      checkpoints,
      settings: { checkpoint: { everyCommits: 3, everyMs: 600_000, minIntervalMs: 0 } },
    });
    const doc = await p.createDocument();
    const a = await p.client('alice', { [doc]: 'owner' });
    expect((await a.open(1, doc)).t).toBe('ch.opened');
    for (let i = 0; i < 3; i++)
      expect((await a.submit(1, { base: i, steps: [insertText(intro(), String(i))] })).t).toBe(
        'sync.ack',
      );
    await until(() => checkpoints.written.includes(3), 3000, 'the checkpoint at seq 3');
    // The tail: two commits after the checkpoint, too few for another one.
    for (let i = 3; i < 5; i++)
      expect((await a.submit(1, { base: i, steps: [insertText(intro(), String(i))] })).t).toBe(
        'sync.ack',
      );
    expect(checkpoints.written.filter((s) => s > 0)).toEqual([3]);

    // Another node over the same storage opens the room cold. The content at 0 is gone, so the
    // room cannot have been built by a replay from seq 1.
    checkpoints.hideZero = true;
    checkpoints.loaded.length = 0;
    spy.reads.length = 0;
    const q = await plane({ stores: shared, checkpoints, tenant: p.tenant });
    const b = await q.client('carol', { [doc]: 'editor' });
    const opened = await b.open(1, doc);
    expect(opened.d).toMatchObject({ head: 5 });
    const openReads = [...spy.reads];
    expect(checkpoints.loaded).toEqual([3]);
    // The tail after the checkpoint, and the one commit at the checkpoint for the revision in force
    // there. Nothing below seq 3 is read.
    expect(openReads).toContainEqual([4, null]);
    expect(openReads.filter(([from]) => from < 3)).toEqual([]);
    expect((await q.stores.logs.head(q.ref(doc))).seq).toBe(5);

    const content = await q.plane.readContent(
      q.tokens.identity(q.tokens.issue({ user: 'carol', docs: { [doc]: 'editor' } })),
      doc,
    );
    expect(content.seq).toBe(5);
    expect(JSON.stringify(content.doc)).toContain('43210This agreement');
    // The room is a working authority: its next commit continues the log.
    expect((await b.submit(1, { base: 5, steps: [insertText(intro(), 'z')] })).d).toMatchObject({
      seq: 6,
    });
    expect(q.errors).toEqual([]);
  });

  it('with no checkpoint above 0 it starts from the content at 0 and replays from seq 1', async () => {
    const stores = makeStores();
    const spy = recordingReads(stores.logs);
    const checkpoints = new Recording();
    const shared = { ...stores, logs: spy.logs };
    const p = await plane({ stores: shared, checkpoints });
    const doc = await p.createDocument();
    const a = await p.client('alice', { [doc]: 'owner' });
    expect((await a.open(1, doc)).t).toBe('ch.opened');
    for (let i = 0; i < 2; i++)
      await a.submit(1, { base: i, steps: [insertText(intro(), String(i))] });
    expect(checkpoints.written.filter((s) => s > 0)).toEqual([]);

    checkpoints.loaded.length = 0;
    spy.reads.length = 0;
    const q = await plane({ stores: shared, checkpoints, tenant: p.tenant });
    const b = await q.client('carol', { [doc]: 'editor' });
    expect((await b.open(1, doc)).d).toMatchObject({ head: 2 });
    expect(checkpoints.loaded).toEqual([0]);
    expect(spy.reads).toContainEqual([1, null]);
  });
}

describe('a room opens from the latest checkpoint and the log tail (BE-019), in memory', () => {
  scenarios(() => {
    const mem = memoryStores();
    return {
      logs: mem.logs,
      ownership: mem.ownership,
      grants: mem.grants,
      documents: mem.documents,
    };
  });
});

describe.skipIf(unavailable !== null)(
  'a room opens from the latest checkpoint and the log tail (BE-019), over PostgreSQL',
  () => {
    let db: TestDatabase;
    beforeAll(async () => {
      db = await createTestDatabase();
    });
    afterAll(async () => {
      await db?.drop();
    });
    scenarios(() => {
      const s = pgStores(db.service);
      return { logs: s.logs, ownership: s.logs, grants: s.grants, documents: s.docs };
    });
  },
);
