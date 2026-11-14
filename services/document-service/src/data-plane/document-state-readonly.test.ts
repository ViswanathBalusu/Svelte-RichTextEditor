/**
 * A locked or archived document raises `perm.changed` with a higher revision and `document.updated`
 * on every open connection, and a commit to it is refused with `read_only` (PRO-047 criterion 3;
 * 04 §5 step 1; 07 §4, §9). The state change is made the way the control plane makes it: the grants
 * (with the document state) are stored, the room is told of the permission change and then of the
 * document change (handlers.ts, `updateDocument`). The real data plane runs over the in-memory
 * stores (test/data-plane/support.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { insertText } from '../../test/data-plane/client.ts';
import { startPlane, type Plane } from '../../test/data-plane/support.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');

let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

async function plane(): Promise<Plane> {
  const p = await startPlane();
  planes.push(p);
  return p;
}

/** A document with alice (owner), bob (editor) and frank (viewer), each on channel 1. */
async function room(p: Plane) {
  const doc = await p.createDocument();
  const alice = await p.client('alice', { [doc]: 'owner' });
  const bob = await p.client('bob', { [doc]: 'editor' });
  const frank = await p.client('frank', { [doc]: 'viewer' });
  for (const c of [alice, bob, frank]) await c.open(1, doc);
  return { doc, alice, bob, frank };
}

for (const state of ['locked', 'archived'] as const) {
  describe(`a ${state} document (PRO-047 criterion 3)`, () => {
    it(`tells every connection and refuses a commit with read_only`, async () => {
      const p = await plane();
      const { doc, alice, bob, frank } = await room(p);
      const ref = p.ref(doc);
      const before = await p.stores.grants.current(ref);

      await p.changeGrants(doc, { documentState: state });
      p.plane.documentChanged(ref);

      for (const c of [alice, bob, frank]) {
        const pc = await c.take((m) => m.t === 'perm.changed');
        expect(pc.ch).toBe(1);
        expect(pc.d!['rev'] as number).toBeGreaterThan(before.revision);
        const changed = await c.take(
          (m) => m.t === 'event' && m.d?.['type'] === 'document.updated',
        );
        expect(changed.d).toEqual({ type: 'document.updated', resource: `/documents/${doc}` });
      }

      // The editor's commit, based on the head it has, is refused and nothing is stored.
      const seen = bob.all('perm.changed')[0]!;
      const ack = await bob.submit(1, {
        base: seen.d!['asOfSeq'],
        steps: [insertText(intro(), 'after the state change')],
      });
      expect(ack.t).toBe('sync.reject');
      expect(ack.d).toMatchObject({ code: 'read_only', action: 'drop' });
      // Nothing of the refused commit is stored: the log holds no trace of its text.
      const logged = JSON.stringify(await p.stores.logs.read(ref));
      expect(logged).not.toContain('after the state change');
    });
  });
}
