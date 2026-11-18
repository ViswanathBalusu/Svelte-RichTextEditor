// An announcement sent through the bus may be lost, and a commit is still never stored under
// replaced grants (BE-063 criterion 5; BE-026). The change is written to storage on node-b (where
// the control plane would run); the room is on node-a. The announcement tells node-a to read again.
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc } from '../../../../packages/authority/test/fixtures.ts';
import { AnnouncingNotifier, listenForAnnouncements } from '../../src/data-plane/announcements.ts';
import { MemoryBusNetwork } from '../../src/data-plane/bus.ts';
import { insertText } from './client.ts';
import { cluster, docFor, seeded, type Cluster } from './forwarding-support.ts';

const TERMS_ID = 'rTerms000000000A';

/** The position inside the first text block of a region of the fixture document. */
function insideRegion(rid: string): number {
  const d = baseDoc();
  let inside = -1;
  d.descendants((node, pos) => {
    if (inside >= 0) return false;
    if (node.type.name === 'region' && node.attrs['id'] === rid) {
      node.descendants((child, cpos) => {
        if (inside < 0 && child.isTextblock) inside = pos + 1 + cpos + 1;
        return inside < 0;
      });
      return false;
    }
    return true;
  });
  return inside;
}

let c: Cluster | null = null;
afterEach(async () => {
  await c?.close();
  c = null;
});

async function setup() {
  c = cluster();
  const net = new MemoryBusNetwork(seeded(21));
  const busA = net.connect('node-a');
  const busB = net.connect('node-b');
  const a = await c.start('node-a', busA);
  const b = await c.start('node-b', busB);
  const errors: unknown[] = [];
  await listenForAnnouncements(busA, 'node-a', a.plane, c.mem, (e) => errors.push(e));
  const controlPlaneOfB = new AnnouncingNotifier(b.plane, busB);
  const doc = await docFor(a, 'node-a');
  const alice = await a.client('alice', { [doc]: 'owner' });
  expect((await alice.open(1, doc)).t).toBe('ch.opened');
  /** What the control plane on node-b does: write the change, then announce it. */
  const approve = async () => {
    const perms = await c!.mem.change(
      a.ref(doc),
      { setRegionStates: [{ region: TERMS_ID, state: 'approved' }] },
      { actor: 'alice' },
    );
    controlPlaneOfB.permissionsChanged(a.ref(doc), perms);
  };
  return { net, a, b, doc, alice, approve, errors };
}

describe('an announcement through the bus (BE-063 criterion 5)', () => {
  it('reaches the owning room on another node, which sends perm.changed', async () => {
    const { alice, approve, errors } = await setup();
    await approve();
    const seen = await alice.take((m) => m.t === 'perm.changed', 3000, 'perm.changed');
    const ack = await alice.submit(1, {
      base: seen.d!['asOfSeq'] as number,
      steps: [insertText(insideRegion(TERMS_ID), 'x')],
    });
    expect(ack.t).toBe('sync.reject');
    expect(ack.d).toMatchObject({ code: 'permission_denied' });
    expect(errors).toEqual([]);
  });

  it('may be lost: the commit checked against the old grants is refused and nothing is stored under them', async () => {
    const { net, a, doc, alice, approve } = await setup();
    net.faults.drop = 1;
    await approve();
    await new Promise((r) => setTimeout(r, 200));
    expect(alice.all('perm.changed')).toHaveLength(0);
    // The room has not heard. The commit is checked against the grants it holds, and the log write
    // is conditional on the revision in storage, so it is refused and nothing is stored.
    const id = alice.submitNoWait(1, {
      base: 0,
      steps: [insertText(insideRegion(TERMS_ID), 'x')],
    });
    // Either the commit is rejected for resubmission, or the room, which reloads the grants it
    // found out of date, closes the channel with unavailable. Nothing is acknowledged.
    const answer = await alice.take((m) => m.re === id || m.t === 'ch.closed', 5000, 'a refusal');
    expect(['sync.reject', 'ch.closed']).toContain(answer.t);
    expect(answer.d).toMatchObject({ code: expect.stringMatching(/unavailable|stale|permission/) });
    expect((await c!.mem.read(a.ref(doc), 1)).filter((x) => x.kind !== 'control')).toEqual([]);
    // The room read the grants again. It may close the channel for the client to reopen (BE-026
    // criterion 2: "rejected with unavailable for resubmission"); then the client reopens.
    await new Promise((r) => setTimeout(r, 300));
    if (alice.all('ch.closed').length > 0) {
      // The room is still stopping for a moment; the client tries again, as the close tells it to.
      let reopened = await alice.open(1, doc);
      for (let i = 0; i < 20 && reopened.t !== 'ch.opened'; i++) {
        expect(reopened.d).toMatchObject({ code: 'unavailable' });
        await new Promise((r) => setTimeout(r, 100));
        reopened = await alice.open(1, doc);
      }
      expect(
        reopened.t,
        JSON.stringify([reopened.d, alice.all('ch.closed').map((m) => m.d), a.errors.map(String)]),
      ).toBe('ch.opened');
    }
    const again = await alice.submit(1, {
      base: 0,
      steps: [insertText(insideRegion(TERMS_ID), 'x')],
    });
    expect(again.t).toBe('sync.reject');
    expect(again.d).toMatchObject({ code: 'permission_denied' });
    expect((await c!.mem.read(a.ref(doc), 1)).filter((x) => x.kind !== 'control')).toEqual([]);
  });
});
