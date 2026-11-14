/**
 * Checkpoint triggers (BE-020), idle close and the memory budget (BE-021; 06 §2.2 steps 3 and 4).
 * The tests drive the real data plane over the in-memory stores with real timers and short
 * settings. The defaults are the spec's (2,000 commits, ten minutes, two minutes, 60 s;
 * `src/data-plane/settings.ts`), and no default is measured here. Each checkpoint write is recorded
 * with the time it was stored, so the spacing rules can be checked against it.
 */
import type { JsonEnvelope } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { insertText, type DepClient } from '../../test/data-plane/client.ts';
import { MemoryCheckpoints, startPlane, until, type Plane } from '../../test/data-plane/support.ts';
import type { DocRef } from '../storage/types.ts';
import { settingsFrom } from './settings.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');

/** Checkpoints that record each write (seq above 0) with its time, and can fail on demand. */
class Recording extends MemoryCheckpoints {
  readonly writes: { seq: number; at: number }[] = [];
  fail = false;
  override async put(ref: DocRef, seq: number, content: JsonEnvelope): Promise<void> {
    if (seq > 0) {
      if (this.fail) throw new Error('object storage is unavailable');
      this.writes.push({ seq, at: Date.now() });
    }
    return super.put(ref, seq, content);
  }
}

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

/** Opens channel 1 of `doc` and returns a function that stores one more commit. */
async function writer(p: Plane, doc: string, user: 'alice' | 'bob' = 'alice') {
  const c: DepClient = await p.client(user, { [doc]: 'owner' });
  const opened = await c.open(1, doc);
  expect(opened, JSON.stringify(opened)).toMatchObject({ t: 'ch.opened' });
  let base = 0;
  return {
    client: c,
    /** Stores one commit and returns its acknowledgement. */
    async commit() {
      const r = await c.submit(1, { base, steps: [insertText(intro(), `${base}`)] });
      expect(r.t).toBe('sync.ack');
      base++;
      return r;
    },
  };
}

describe('spec defaults (BE-020, BE-021)', () => {
  it('resolves to 2,000 commits, ten minutes, two minutes between checkpoints and a 60 s idle delay', () => {
    const s = settingsFrom({});
    expect(s.checkpoint).toEqual({ everyCommits: 2000, everyMs: 600_000, minIntervalMs: 120_000 });
    expect(s.roomIdleMs).toBe(60_000);
  });
});

describe('checkpoint triggers (BE-020 criterion 1)', () => {
  it('writes a checkpoint once everyCommits commits are stored, and not before', async () => {
    const cp = new Recording();
    const p = await plane({
      checkpoints: cp,
      settings: { checkpoint: { everyCommits: 3, everyMs: 600_000, minIntervalMs: 0 } },
    });
    const doc = await p.createDocument();
    const w = await writer(p, doc);
    await w.commit();
    await w.commit();
    await new Promise((r) => setTimeout(r, 60));
    expect(cp.writes).toEqual([]);
    await w.commit();
    await until(() => cp.writes.length === 1, 3000, 'the checkpoint after three commits');
    expect(cp.writes[0]?.seq).toBe(3);
  });

  it('writes a checkpoint everyMs after the first uncheckpointed commit', async () => {
    const cp = new Recording();
    const p = await plane({
      checkpoints: cp,
      settings: { checkpoint: { everyCommits: 2000, everyMs: 150, minIntervalMs: 0 } },
    });
    const doc = await p.createDocument();
    const w = await writer(p, doc);
    const t0 = Date.now();
    await w.commit();
    await until(() => cp.writes.length === 1, 3000, 'the time-based checkpoint');
    // The timer starts when the commit is stored, which is after t0, so the write cannot come
    // earlier than everyMs after t0.
    expect(cp.writes[0]!.at - t0).toBeGreaterThanOrEqual(150);
    expect(cp.writes[0]!.seq).toBe(1);
  });

  it('never writes two checkpoints closer together than minIntervalMs', async () => {
    const cp = new Recording();
    const p = await plane({
      checkpoints: cp,
      settings: { checkpoint: { everyCommits: 1, everyMs: 600_000, minIntervalMs: 300 } },
    });
    const doc = await p.createDocument();
    const w = await writer(p, doc);
    await w.commit();
    await until(() => cp.writes.length === 1, 3000, 'the first checkpoint');
    await w.commit();
    await until(() => cp.writes.length === 2, 3000, 'the second checkpoint');
    expect(cp.writes[1]!.seq).toBe(2);
    expect(cp.writes[1]!.at - cp.writes[0]!.at).toBeGreaterThanOrEqual(300);
  });

  it('keeps acknowledging commits while object storage fails, counts the failure, and checkpoints again when it returns', async () => {
    const cp = new Recording();
    const p = await plane({
      checkpoints: cp,
      settings: { checkpoint: { everyCommits: 1, everyMs: 600_000, minIntervalMs: 0 } },
    });
    const doc = await p.createDocument();
    const w = await writer(p, doc);
    cp.fail = true;
    await w.commit();
    await w.commit();
    // Commits are still stored and acknowledged (the log alone is durable, BE-020 criterion 6).
    await until(
      () => /dep_checkpoint_failures_total\{[^}]*\} [1-9]/.test(p.plane.metrics()),
      3000,
      'the checkpoint failure to be counted',
    );
    expect(cp.writes).toEqual([]);
    cp.fail = false;
    await w.commit();
    await until(() => cp.writes.length >= 1, 3000, 'a checkpoint once storage returns');
    expect(cp.writes.at(-1)?.seq).toBe(3);
  });
});

describe('idle close and the memory budget (BE-021)', () => {
  it('checkpoints a room with changes and frees it when its last channel has been gone for roomIdleMs', async () => {
    const cp = new Recording();
    const p = await plane({
      checkpoints: cp,
      settings: {
        roomIdleMs: 100,
        checkpoint: { everyCommits: 2000, everyMs: 600_000, minIntervalMs: 0 },
      },
    });
    const doc = await p.createDocument();
    const w = await writer(p, doc);
    await w.commit();
    w.client.terminate();
    await until(() => p.plane.host.rooms.length === 0, 3000, 'the idle room to close');
    expect(cp.writes.map((x) => x.seq)).toContain(1);
  });

  it('keeps the room open, with no close and no checkpoint, when a channel opens within roomIdleMs', async () => {
    const cp = new Recording();
    const p = await plane({
      checkpoints: cp,
      settings: {
        roomIdleMs: 300,
        checkpoint: { everyCommits: 2000, everyMs: 600_000, minIntervalMs: 0 },
      },
    });
    const doc = await p.createDocument();
    const a = await writer(p, doc);
    await a.commit();
    a.client.terminate();
    await new Promise((r) => setTimeout(r, 100));
    const b = await writer(p, doc, 'bob');
    await new Promise((r) => setTimeout(r, 400));
    expect(p.plane.host.rooms).toHaveLength(1);
    expect(p.plane.host.rooms[0]!.idle).toBe(false);
    expect(cp.writes).toEqual([]);
    // The room still serves: bob's commit continues from the head that alice left.
    const r = await b.client.submit(1, { base: 1, steps: [insertText(intro(), 'b')] });
    expect(r.t).toBe('sync.ack');
  });

  it('does not close a room that has just loaded, under a budget it exceeds, before its channel attaches', async () => {
    const p = await plane({ settings: { roomIdleMs: 60_000, roomMemoryBudget: 1 } });
    const doc = await p.createDocument();
    // Opening runs the budget check at once; the room has no channel yet. The channel must open.
    const w = await writer(p, doc);
    await w.commit();
    expect(p.plane.host.rooms).toHaveLength(1);
    expect(p.plane.host.rooms[0]!.idle).toBe(false);
    expect(p.plane.host.rooms[0]!.idleSince).toBeNull();
  });

  it('closes only idle rooms when the estimate is above the budget, and never a room with a channel', async () => {
    const p = await plane({
      settings: { roomIdleMs: 60_000, roomMemoryBudget: 1 },
    });
    const idleDoc = await p.createDocument();
    const busyDoc = await p.createDocument();
    // The busy room loads first. Loading a room runs the budget check, and a room that has just
    // loaded (no channel, no idleSince) must not be closed while its channel attaches.
    const b = await writer(p, busyDoc, 'bob');
    await b.commit();
    const a = await writer(p, idleDoc);
    await a.commit();
    a.client.terminate();
    await until(
      () => p.plane.host.rooms.some((r) => r.idle && r.idleSince !== null),
      3000,
      'the idle room',
    );
    // No load runs before the explicit check, so both rooms are still open here.
    expect(p.plane.host.rooms).toHaveLength(2);
    const closed = await p.plane.host.enforceBudget();
    expect(closed).toBe(1);
    expect(p.plane.host.rooms).toHaveLength(1);
    expect(p.plane.host.rooms[0]!.idle).toBe(false);
    expect(p.plane.host.get(p.ref(busyDoc))).toBeDefined();
    expect(p.plane.host.get(p.ref(idleDoc))).toBeUndefined();
  });
});
