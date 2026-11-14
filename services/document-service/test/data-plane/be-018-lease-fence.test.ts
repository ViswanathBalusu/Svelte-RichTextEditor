// A node that cannot prove its lease stops every room, viewers' rooms too (BE-018 criterion 2).
// The plane runs in process over the in-memory stores. Its node lease uses short real timers
// (renewal every 100 ms, a 800 ms lease): the renewals then fail on purpose, as an unreachable
// database would make them, and the room host must close each channel with `ch.closed` and code
// `unavailable`. The lease alone is tested with fake timers in src/data-plane/lease.test.ts.
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryNodeLeases } from '../../src/data-plane/memory-ports.ts';
import type { DataPlaneSettings } from '../../src/seams.ts';
import { MemoryStore } from '../../src/storage/memory.ts';
import { startPlane, until, type Plane } from './support.ts';

const leaseSettings: DataPlaneSettings = {
  lease: { durationMs: 800, renewMs: 100, marginMs: 100 },
};

let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

describe('a node that cannot prove its lease stops every room (BE-018 criterion 2)', () => {
  it('closes the channels of an editor and of a viewer with ch.closed and unavailable, and stops the rooms', async () => {
    const mem = new MemoryStore();
    const leases = new MemoryNodeLeases();
    const p = await startPlane({
      stores: { logs: mem, ownership: mem, grants: mem, documents: mem },
      settings: leaseSettings,
      deps: { leases },
      node: 'node-a',
    });
    planes.push(p);
    expect(await p.plane.ready()).toBe(true);

    const doc = await p.createDocument();
    const editor = await p.client('alice', { [doc]: 'editor' });
    const viewer = await p.client('bob', { [doc]: 'viewer' });
    expect((await editor.open(1, doc)).t).toBe('ch.opened');
    expect((await viewer.open(1, doc)).t).toBe('ch.opened');
    expect(p.plane.host.rooms).toHaveLength(1);

    // The database becomes unreachable: no renewal succeeds, so the node cannot prove its lease.
    leases.failing = true;

    // Both channels are closed by the room host, the viewer's included.
    const closedEditor = await editor.take(
      (m) => m.t === 'ch.closed',
      3000,
      'ch.closed for the editor',
    );
    const closedViewer = await viewer.take(
      (m) => m.t === 'ch.closed',
      3000,
      'ch.closed for the viewer',
    );
    expect(closedEditor.d).toMatchObject({ code: 'unavailable' });
    expect(closedViewer.d).toMatchObject({ code: 'unavailable' });

    // The rooms are gone from the host and the lease is no longer proved.
    await until(() => p.plane.host.rooms.length === 0, 3000, 'the room to stop');
    expect(p.plane.lease?.proven).toBe(false);
    expect(p.plane.lease?.stats.lost).toBe(1);
  });
});
