// BE-021 criterion 4 (lane V-BE-015-028): when the room memory approaches the budget, idle rooms are
// closed first, and the memory of the rooms is reported in the metrics (BE-086). The plane is the real
// one over the in-memory stores. The budget is a small test value, not the figure BE-084 measures.
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { insertText } from './client.ts';
import { startPlane, until, type Plane } from './support.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');

let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

/** The value of `dep_room_memory_bytes` for the plane's node and tenant, or null when absent. */
function roomMemory(p: Plane): number | null {
  const m = p.plane.metrics().match(/^dep_room_memory_bytes\{[^}]*\} (\S+)$/m);
  return m ? Number(m[1]) : null;
}

describe('the room memory budget closes idle rooms first and is reported (BE-021 criterion 4)', () => {
  it('closes the idle room when the estimate is above the budget and reports the memory left', async () => {
    const p = await startPlane({
      settings: { roomIdleMs: 60_000, roomMemoryBudget: 1 },
    });
    planes.push(p);

    const busyDoc = await p.createDocument();
    const idleDoc = await p.createDocument();

    // The busy room keeps its channel open; the idle room's only channel closes after a commit.
    const bob = await p.client('bob', { [busyDoc]: 'owner' });
    expect((await bob.open(1, busyDoc)).t).toBe('ch.opened');
    expect((await bob.submit(1, { base: 0, steps: [insertText(intro(), 'busy')] })).t).toBe(
      'sync.ack',
    );

    const alice = await p.client('alice', { [idleDoc]: 'owner' });
    expect((await alice.open(1, idleDoc)).t).toBe('ch.opened');
    expect((await alice.submit(1, { base: 0, steps: [insertText(intro(), 'idle')] })).t).toBe(
      'sync.ack',
    );
    alice.terminate();
    await until(
      () => p.plane.host.rooms.some((r) => r.idle && r.idleSince !== null),
      3000,
      'the idle room',
    );

    // Both rooms are open and their memory is reported before the budget check runs.
    expect(p.plane.host.rooms).toHaveLength(2);
    const before = roomMemory(p);
    expect(before, 'dep_room_memory_bytes is reported').not.toBeNull();
    expect(before!).toBeGreaterThan(0);

    const closed = await p.plane.host.enforceBudget();
    expect(closed).toBe(1);
    expect(p.plane.host.get(p.ref(idleDoc))).toBeUndefined();
    expect(p.plane.host.get(p.ref(busyDoc))).toBeDefined();

    // The room with a channel is never the one closed, and the metric reports what remains.
    const after = roomMemory(p);
    expect(after, 'dep_room_memory_bytes is still reported').not.toBeNull();
    expect(after!).toBeLessThan(before!);
    expect(p.plane.metrics()).toMatch(/^dep_open_rooms\{[^}]*\} 1$/m);
    expect(p.errors).toEqual([]);
  });
});
