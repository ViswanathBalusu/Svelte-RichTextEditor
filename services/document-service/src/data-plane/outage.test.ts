/**
 * Rejections while the database is unavailable (BE-077; 06 §8, PostgreSQL unavailable; 04 §5).
 * The real data plane runs over the in-memory stores with the test hook that makes the database
 * unreachable for the node (BE-079). While it is down, a commit is rejected with the retryable
 * `unavailable`, nothing is acknowledged that is not stored, the channel stays open, and content
 * reads return `unavailable`. When the database returns, the same channel resumes, and a
 * resubmitted commit with the same identifier is stored once.
 *
 * Not covered here (BE-077 criteria 4 and the readiness part of 5): the node lease and the readiness
 * probe belong to the server (`src/server.ts`) and to the lease (BE-018), not to the room host.
 */
import { uuid7 } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { insertText } from '../../test/data-plane/client.ts';
import { startPlane, type Plane } from '../../test/data-plane/support.ts';
import { DataPlaneError } from './wire.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');

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

describe('rejections while PostgreSQL is unavailable (BE-077)', () => {
  it('rejects commits with the retryable unavailable, acknowledges none, and keeps the channel open', async () => {
    const p = await plane({ settings: { testMode: true } });
    const doc = await p.createDocument();
    const ref = p.ref(doc);
    const a = await p.client('alice', { [doc]: 'owner' });
    expect((await a.open(1, doc)).t).toBe('ch.opened');

    p.plane.hooks!.dropDatabase(true);
    const id = uuid7();
    const env = a.submitNoWait(1, { id, base: 0, steps: [insertText(intro(), 'lost for now')] });
    const r = await a.take((m) => m.re === env, 3000, 'the rejection');
    expect(r.t).toBe('sync.reject');
    expect(r.d).toMatchObject({ id, code: 'unavailable', action: 'retry', head: 0 });

    // A second commit in the same outage is rejected the same way.
    const again = await a.submit(1, { base: 0, steps: [insertText(intro(), 'still down')] });
    expect(again.t).toBe('sync.reject');
    expect(again.d).toMatchObject({ code: 'unavailable', action: 'retry' });

    // Nothing was acknowledged and nothing was stored.
    expect(a.log.some((m) => m.t === 'sync.ack')).toBe(false);
    expect(await p.stores.logs.read(ref)).toHaveLength(0);

    // Rejections alone do not close the channel.
    expect(a.closeInfo).toBeNull();
    expect(a.log.some((m) => m.t === 'ch.closed')).toBe(false);
  });

  it('resumes on the same channel when the database returns, and stores a resubmitted commit once', async () => {
    const p = await plane({ settings: { testMode: true } });
    const doc = await p.createDocument();
    const ref = p.ref(doc);
    const a = await p.client('alice', { [doc]: 'owner' });
    await a.open(1, doc);

    const id = uuid7();
    p.plane.hooks!.dropDatabase(true);
    const rejected = await a.submit(1, { id, base: 0, steps: [insertText(intro(), 'one')] });
    expect(rejected.t).toBe('sync.reject');

    p.plane.hooks!.dropDatabase(false);
    const ok = await a.submit(1, { id, base: 0, steps: [insertText(intro(), 'one')] });
    expect(ok.t).toBe('sync.ack');
    expect(ok.d).toMatchObject({ id, seq: 1 });

    // The same identifier sent again is answered from the stored commit, not stored a second time.
    const dup = await a.submit(1, { id, base: 0, steps: [insertText(intro(), 'one')] });
    expect(dup.t).toBe('sync.ack');
    expect(dup.d).toMatchObject({ id, seq: 1 });

    const next = await a.submit(1, { base: 1, steps: [insertText(intro(), 'two')] });
    expect(next.d).toMatchObject({ seq: 2 });
    expect((await p.stores.logs.read(ref)).map((c) => c.seq)).toEqual([1, 2]);
    expect(a.closeInfo).toBeNull();
  });

  it('answers content reads with unavailable while the database is down, and serves them again afterwards', async () => {
    const p = await plane({ settings: { testMode: true } });
    const doc = await p.createDocument();
    const identity = p.tokens.identity(p.tokens.issue({ user: 'alice', docs: { [doc]: 'owner' } }));

    p.plane.hooks!.dropDatabase(true);
    const down = await p.plane.readContent(identity, doc).then(
      () => null,
      (e: unknown) => e,
    );
    expect(down).toBeInstanceOf(DataPlaneError);
    expect((down as DataPlaneError).code).toBe('unavailable');

    p.plane.hooks!.dropDatabase(false);
    const content = await p.plane.readContent(identity, doc);
    expect(content.seq).toBe(0);
  });
});
