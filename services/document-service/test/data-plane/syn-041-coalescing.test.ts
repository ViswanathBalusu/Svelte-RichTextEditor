// SYN-041 through the data plane (04 §12, §5 step 10; SYN-015): with coalescing configured, the
// room's output from the real RoomBridge goes through the broadcast window, and real WebSocket
// clients see one `sync.commit` per window, an acknowledgement never ahead of a held lower commit,
// and no hold below the subscriber threshold. Storage is MemoryStore: the window sits after the
// write, so the store does not change what is tested here.
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { insertText, type DepClient, type Received } from './client.ts';
import { startPlane, until, type Plane } from './support.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');
const legal = () => posInside(baseDoc(), 'pLegal000000001B');

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

/** The sync messages of channel 1 in arrival order: commit messages as their seqs, acks as seq. */
function syncOrder(c: DepClient): Array<[string, number[] | number]> {
  return c.log
    .filter((m: Received) => m.ch === 1 && (m.t === 'sync.commit' || m.t === 'sync.ack'))
    .map((m) =>
      m.t === 'sync.commit'
        ? [m.t, m.d!['commits'].map((x: { seq: number }) => x.seq)]
        : [m.t, m.d!['seq'] as number],
    );
}

const commitSeqs = (m: Received): number[] => m.d!['commits'].map((x: { seq: number }) => x.seq);

const commitBatches = (c: DepClient) => c.all('sync.commit', 1).map(commitSeqs);

async function room(p: Plane): Promise<{ alice: DepClient; carol: DepClient; frank: DepClient }> {
  const doc = await p.createDocument();
  const alice = await p.client('alice', { [doc]: 'owner' });
  const carol = await p.client('carol', { [doc]: 'editor' });
  const frank = await p.client('frank', { [doc]: 'viewer' });
  for (const c of [alice, carol, frank]) await c.open(1, doc);
  return { alice, carol, frank };
}

describe('the room coalesces its broadcasts on a window (SYN-041)', () => {
  it('sends a held commit before a rejection on the same channel (criterion 2)', async () => {
    const p = await plane({ settings: { coalescing: { windowMs: 2000, minSubscribers: 3 } } });
    const { alice, carol } = await room(p);
    await alice.submit(1, { base: 0, steps: [insertText(intro(), 'a')] });
    await new Promise((r) => setTimeout(r, 50));
    expect(carol.all('sync.commit', 1)).toHaveLength(0);
    // Carol may not change the legal region: the room refuses her commit.
    const r = await carol.submit(1, { base: 0, steps: [insertText(legal(), 'pwned ')] });
    expect(r.t).toBe('sync.reject');
    expect(r.d).toMatchObject({ code: 'permission_denied', head: 1 });
    const order = carol.log
      .filter((m) => m.ch === 1 && (m.t === 'sync.commit' || m.t === 'sync.reject'))
      .map((m) => (m.t === 'sync.commit' ? commitSeqs(m) : m.t));
    expect(order).toEqual([[1], 'sync.reject']);
  });

  it('sends a held commit before an acknowledgement that comes in the same batch (criterion 2)', async () => {
    // A long window, so that the first commit is still held when carol's acknowledgement is sent.
    const p = await plane({ settings: { coalescing: { windowMs: 2000, minSubscribers: 3 } } });
    const { alice, carol, frank } = await room(p);
    expect((await alice.submit(1, { base: 0, steps: [insertText(intro(), 'a')] })).d).toMatchObject(
      {
        seq: 1,
      },
    );
    await new Promise((r) => setTimeout(r, 50));
    // Held: neither carol nor frank has seq 1 yet.
    expect(carol.all('sync.commit', 1)).toHaveLength(0);
    expect(frank.all('sync.commit', 1)).toHaveLength(0);
    // Carol's commit (at a stale base, so the room rebases it) is acknowledged with seq 2. Its
    // acknowledgement ends her held message, which goes first.
    const ack = await carol.submit(1, { base: 0, steps: [insertText(intro(), 'c')] });
    expect(ack.t).toBe('sync.ack');
    expect(ack.d).toMatchObject({ seq: 2 });
    expect(syncOrder(carol)).toEqual([
      ['sync.commit', [1]],
      ['sync.ack', 2],
    ]);
    // Frank's channel still holds seq 1, joined by seq 2: one message, in ascending seq.
    expect(frank.all('sync.commit', 1)).toHaveLength(0);
    await until(() => frank.all('sync.commit', 1).length > 0, 5000, 'the held message');
    expect(commitBatches(frank)).toEqual([[1, 2]]);
    // The author got its acknowledgement only, then carol's commit after its window.
    await until(() => alice.all('sync.commit', 1).length > 0, 5000, "carol's commit");
    expect(syncOrder(alice)).toEqual([
      ['sync.ack', 1],
      ['sync.commit', [2]],
    ]);
    expect(p.errors).toEqual([]);
  });

  it('sends commits that arrive within one window as one sync.commit message', async () => {
    const p = await plane({ settings: { coalescing: { windowMs: 400, minSubscribers: 3 } } });
    const { alice, frank } = await room(p);
    for (let i = 0; i < 3; i++)
      expect((await alice.submit(1, { base: i, steps: [insertText(intro(), `${i}`)] })).t).toBe(
        'sync.ack',
      );
    await until(() => commitBatches(frank).flat().length === 3, 5000, 'three commits');
    expect(commitBatches(frank)).toEqual([[1, 2, 3]]);
  });

  it('holds nothing below the subscriber threshold: each commit goes at once (criterion 4)', async () => {
    // A window far longer than the wait below: a held commit could not arrive in time.
    const p = await plane({ settings: { coalescing: { windowMs: 10_000, minSubscribers: 4 } } });
    const { alice, frank } = await room(p);
    await alice.submit(1, { base: 0, steps: [insertText(intro(), 'a')] });
    await until(() => commitBatches(frank).length === 1, 1000, 'the first commit at once');
    await alice.submit(1, { base: 1, steps: [insertText(intro(), 'b')] });
    await until(() => commitBatches(frank).length === 2, 1000, 'the second commit at once');
    expect(commitBatches(frank)).toEqual([[1], [2]]);
  });

  it('sends held commits before the connection closes when the service stops', async () => {
    const p = await plane({ settings: { coalescing: { windowMs: 10_000, minSubscribers: 3 } } });
    const { alice, frank } = await room(p);
    await alice.submit(1, { base: 0, steps: [insertText(intro(), 'a')] });
    await new Promise((r) => setTimeout(r, 50));
    expect(commitBatches(frank)).toEqual([]);
    // The window is ten seconds; the stop flushes it at once.
    const started = Date.now();
    await p.plane.close();
    expect((await frank.closed).code).toBe(4503);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(commitBatches(frank)).toEqual([[1]]);
  });
});
