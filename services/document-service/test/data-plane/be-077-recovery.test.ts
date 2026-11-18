// After an outage the room reads what the database now holds (BE-077 criterion 3). While the
// database is unreachable for the node (the BE-079 hook), the grants of the document change in
// storage and the announcement to the room is lost. When the database returns, with no restart:
// the first write is refused because the grants revision moved, the room takes the new grants and
// the control commit from storage (the log tail it never wrote), tells the channels, and checks
// the resubmitted commit, with the same identifier, against the new grants. A commit under the new
// state is then stored once. The plane runs over the in-memory stores.
import { uuid7 } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { insertText } from './client.ts';
import { MemoryNodeLeases } from '../../src/data-plane/memory-ports.ts';
import { MemoryStore } from '../../src/storage/memory.ts';
import { startPlane, until, type Plane } from './support.ts';

const mem = new MemoryStore();

const intro = () => posInside(baseDoc(), 'pIntro0000000001');
const legal = () => posInside(baseDoc(), 'pLegal000000001B');

let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

describe('an outage longer than the lease can be proved stops the node (BE-077 criterion 4)', () => {
  it('rejects commits as retryable while the lease holds, then closes every channel with unavailable once it cannot be proved', async () => {
    const p = await startPlane({
      stores: { logs: mem, ownership: mem, grants: mem, documents: mem },
      settings: { testMode: true, lease: { durationMs: 800, renewMs: 100, marginMs: 100 } },
      deps: { leases: new MemoryNodeLeases() },
      node: 'node-a',
    });
    planes.push(p);
    const doc = await p.createDocument();
    const editor = await p.client('alice', { [doc]: 'editor' });
    const viewer = await p.client('bob', { [doc]: 'viewer' });
    await editor.open(1, doc);
    await viewer.open(1, doc);
    expect(p.plane.lease?.proven).toBe(true);

    // The outage starts: the commit is rejected as retryable at once, the channels stay open.
    p.plane.hooks!.dropDatabase(true);
    const r = await editor.submit(1, { base: 0, steps: [insertText(intro(), 'x')] });
    expect(r.d).toMatchObject({ code: 'unavailable', action: 'retry' });
    expect(editor.closeInfo).toBeNull();

    // It lasts: no renewal succeeds, the proof ends, and every room stops (BE-018).
    const closedEditor = await editor.take((m) => m.t === 'ch.closed', 3000, 'ch.closed (editor)');
    const closedViewer = await viewer.take((m) => m.t === 'ch.closed', 3000, 'ch.closed (viewer)');
    expect(closedEditor.d).toMatchObject({ code: 'unavailable' });
    expect(closedViewer.d).toMatchObject({ code: 'unavailable' });
    await until(() => p.plane.host.rooms.length === 0, 3000, 'the room to stop');
    expect(p.plane.lease?.proven).toBe(false);
  });
});

describe('the room resumes from what storage holds when the database returns (BE-077 criterion 3)', () => {
  it('takes grants and a control commit that changed during the outage, then checks the resubmission against them', async () => {
    const p = await startPlane({ settings: { testMode: true } });
    planes.push(p);
    const doc = await p.createDocument();
    const ref = p.ref(doc);
    const bob = await p.client('bob', { [doc]: 'editor' }, { groups: ['legal'] });
    expect((await bob.open(1, doc)).t).toBe('ch.opened');

    // The outage: Bob's commit is rejected as retryable and nothing is stored.
    p.plane.hooks!.dropDatabase(true);
    const id = uuid7();
    const down = await bob.submit(1, { id, base: 0, steps: [insertText(legal(), 'x')] });
    expect(down.d).toMatchObject({ id, code: 'unavailable', action: 'retry' });
    expect(await p.stores.logs.read(ref)).toHaveLength(0);

    // During the outage the grants change in storage; the room is not told.
    await p.changeGrants(
      doc,
      { removeGrants: [{ region: 'rLegal000000000B', principal: 'group:legal' }] },
      false,
    );

    // The database returns. The room has not been restarted and Bob's channel is still open.
    p.plane.hooks!.dropDatabase(false);
    const first = await bob.submit(1, { id, base: 0, steps: [insertText(legal(), 'x')] });
    expect(first.d).toMatchObject({ id, code: 'unavailable', action: 'retry' });
    // The room took the new grants from storage and told the channel.
    const pc = await bob.take((m) => m.t === 'perm.changed');
    expect(pc.d!['rev']).toBe(2);

    // The tail it did not write (the control commit) is in its state: the resubmission at base 1 is
    // checked against the new grants and refused for the region.
    const again = await bob.submit(1, { id, base: 1, steps: [insertText(legal(), 'x')] });
    expect(again.d).toMatchObject({ code: 'permission_denied' });
    expect(bob.closeInfo).toBeNull();

    // A commit the new grants allow is stored once, even when sent twice with one identifier.
    const okId = uuid7();
    const ok = await bob.submit(1, { id: okId, base: 1, steps: [insertText(intro(), 'ok ')] });
    expect(ok.t).toBe('sync.ack');
    expect(ok.d).toMatchObject({ id: okId, seq: 2 });
    const dup = await bob.submit(1, { id: okId, base: 1, steps: [insertText(intro(), 'ok ')] });
    expect(dup.d).toMatchObject({ id: okId, seq: 2 });
    expect((await p.stores.logs.read(ref)).map((c) => [c.seq, c.kind])).toEqual([
      [1, 'control'],
      [2, 'steps'],
    ]);
  });
});
