/**
 * PRM-006 criterion 3 end to end (lane w9; owner decision 104 of 2026-11-15: the region-listing rule
 * of 05 §5.5 is enough, and the engine does no extra tracking). A commit of another user creates a
 * region. Until an access that lists the region arrives, the core treats it as not editable: typing
 * there is refused before anything is sent, the access at the caret says `unlisted`, and the region
 * is among those the web view shades. When the access arrives, the same typing is stored.
 *
 * Both users are connected to backend-mock, which runs the real room and bridge. The room sends
 * `perm.changed` after the commit that creates the region (07 §4). The test holds the delivery of
 * access objects on the second user's channel, which stands for a network that delivers
 * `perm.changed` later than the commit; nothing else on the channel is held.
 */
import type { MockService } from '@docedit/backend-mock';
import type { Access, SyncChannel } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { IDS, contractDocument } from './fixtures.ts';
import { caret, join, microtask, newService, posOf, textOfNode, type, until } from './support.ts';

interface Gate {
  /** While true, access objects are queued and not delivered. */
  held: boolean;
  /** Every access object that reached the channel, delivered or not, in order. */
  arrived: Access[];
  release(): void;
}

/** Joins as `join` does, with the delivery of access objects on the channel behind a gate. */
async function joinGated(
  service: MockService,
  docId: string,
  sub: string,
): Promise<{ core: DocumentCore; detach: () => void; gate: Gate }> {
  const backend = service.backend({ sub }, { [docId]: 'editor' });
  await backend.connect();
  const content = await backend.sync.loadContent(docId);
  const core = new DocumentCore({ doc: content, schedule: microtask });
  const queue: Array<() => void> = [];
  const gate: Gate = {
    held: false,
    arrived: [],
    release() {
      gate.held = false;
      for (const deliver of queue.splice(0)) deliver();
    },
  };
  const open = async (id: string, opts: Parameters<typeof backend.sync.open>[1] = {}) => {
    const channel = await backend.sync.open(id, opts);
    const gated: SyncChannel = {
      get docId() {
        return channel.docId;
      },
      get opened() {
        return channel.opened;
      },
      submit: (commit) => channel.submit(commit),
      onCommits: (cb) => channel.onCommits(cb),
      onReset: (cb) => channel.onReset(cb),
      onAccess: (cb) =>
        channel.onAccess((access) => {
          gate.arrived.push(access);
          if (gate.held) queue.push(() => cb(access));
          else cb(access);
        }),
      onEvent: (cb) => channel.onEvent(cb),
      onState: (cb) => channel.onState(cb),
      onCheck: (cb) => channel.onCheck(cb),
      close: () => channel.close(),
    };
    return gated;
  };
  const port = { open, loadContent: backend.sync.loadContent.bind(backend.sync) };
  const channel = await port.open(docId, {
    resume: { seq: content.seq, incarnation: content.incarnation },
  });
  const detach = core.attach(channel, {
    seq: content.seq,
    incarnation: content.incarnation,
    sync: port,
    batchMs: 0,
    retry: { minMs: 2, maxMs: 20 },
  });
  return { core, detach, gate };
}

/** The identifier of the region that holds the paragraph `id`, or null. */
function regionOf(core: DocumentCore, id: string): string | null {
  const doc = internals(core).state.doc;
  const $pos = doc.resolve(posOf(doc, id) + 1);
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d);
    if (node.type.name === 'region') return String(node.attrs['id']);
  }
  return null;
}

describe('a region created by a commit just received (PRM-006 criterion 3)', () => {
  it('is not editable until an access that lists it arrives, and then it is', async () => {
    const service = newService();
    const docId = service.createDocument(contractDocument(), { grants: [] });
    const ada = await join(service, docId, 'ada', 'owner');
    const bob = await joinGated(service, docId, 'bob');
    await until(() => bob.core.permissions.get() !== null, "Bob's first access");
    await until(() => ada.core.permissions.get() !== null, "Ada's first access");

    // Bob may edit the body paragraph today.
    caret(bob.core, IDS.mid, 'end');
    type(bob.core, '!');
    await until(
      () => textOfNode(internals(ada.core).state.doc, IDS.mid) === 'Between!',
      'the edit',
    );
    await until(() => bob.core.syncSummary.get().queued === 0, "Bob's queue to drain");
    const headBefore = bob.core.confirmedSeq.get();

    // Ada wraps that paragraph in a new region; Bob's access objects are held from here on.
    bob.gate.held = true;
    caret(ada.core, IDS.mid, 0);
    expect(ada.core.run('markRegion', { title: 'New part' })).toBe(true);
    await until(() => regionOf(bob.core, IDS.mid) !== null, "the region in Bob's document");
    const region = regionOf(bob.core, IDS.mid)!;
    const scope = `region:${region}`;
    const createdSeq = bob.core.confirmedSeq.get();
    expect(createdSeq).toBeGreaterThan(headBefore);

    // The room's perm.changed for the new region list has reached the channel and is held.
    await until(() => bob.gate.arrived.some((a) => scope in a.scopes), 'the held access');
    const listing = bob.gate.arrived.find((a) => scope in a.scopes)!;
    // An access that lists the region is never older than the commit that created it, which is
    // why the listing alone is enough (decision 104).
    expect(listing.asOfSeq).toBeGreaterThanOrEqual(createdSeq);
    expect(listing.scopes[scope]).toContain('edit');

    // Bob's core has the region and an access that does not list it: not editable.
    const held = bob.core.permissions.get()!;
    expect(held.scopes[scope]).toBeUndefined();
    expect(held.asOfSeq).toBeLessThan(createdSeq);
    expect(bob.core.canEdit(scope)).toBe(false);
    caret(bob.core, IDS.mid, 'end');
    expect(bob.core.access.get()).toMatchObject({ scope, limit: 'unlisted' });
    expect(bob.core.regionLocks().map((l) => [l.id, l.unlisted])).toContainEqual([region, true]);
    const refusals = bob.core.refusal.get()?.n ?? 0;
    type(bob.core, 'X');
    expect(textOfNode(internals(bob.core).state.doc, IDS.mid)).toBe('Between!');
    expect(bob.core.refusal.get()).toMatchObject({
      n: refusals + 1,
      reason: 'scope',
      scopes: [scope],
    });
    expect(bob.core.syncSummary.get()).toMatchObject({ inflight: null, queued: 0 });

    // The access arrives: the region is listed with `edit`, and the same typing is stored.
    bob.gate.release();
    await until(
      () => bob.core.permissions.get()?.scopes[scope]?.includes('edit') === true,
      'the listing access',
    );
    expect(bob.core.canEdit(scope)).toBe(true);
    expect(bob.core.regionLocks().map((l) => l.id)).not.toContain(region);
    caret(bob.core, IDS.mid, 'end');
    expect(bob.core.access.get()).toMatchObject({ scope, limit: null });
    type(bob.core, 'Y');
    expect(textOfNode(internals(bob.core).state.doc, IDS.mid)).toBe('Between!Y');
    await until(
      () => textOfNode(internals(ada.core).state.doc, IDS.mid) === 'Between!Y',
      "Bob's edit in Ada's document",
    );
    expect(bob.core.refusal.get()?.n ?? 0).toBe(refusals + 1);

    ada.detach();
    bob.detach();
    await service.dispose();
  });
});
