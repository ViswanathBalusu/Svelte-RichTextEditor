// The room host (06 §2; BE-019, BE-024, BE-025): a room opened from the content at sequence number 0
// and the log, ownership claimed and released, one write in flight, and the reaction to failed,
// unknown, lost and fenced writes, seen by real WebSocket clients.
import { OutcomeUnknownError } from '../../src/storage/types.ts';
import { uuid7 } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { insertText } from './client.ts';
import { GatedLogStore, memoryStores, startPlane, until, type Plane } from './support.ts';

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

function gatedPlane(opts: Parameters<typeof startPlane>[0] = {}) {
  const mem = memoryStores().memory;
  const gated = new GatedLogStore(mem);
  return {
    mem,
    gated,
    start: () =>
      plane({ ...opts, stores: { logs: gated, ownership: mem, grants: mem, documents: mem } }),
  };
}

describe('opening a room from storage (BE-019)', () => {
  it('claims ownership, replays the log from seq 1 and serves the head', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const a = await p.client('alice', { [doc]: 'owner' });
    await a.open(1, doc);
    for (let i = 0; i < 4; i++)
      await a.submit(1, { base: i, steps: [insertText(intro(), String(i))] });
    const epochBefore = (await p.stores.logs.head(p.ref(doc))).epoch;
    // Another node over the same storage: it opens the room cold.
    const q = await plane({ stores: p.stores, checkpoints: p.checkpoints, tenant: p.tenant });
    const b = await q.client('carol', { [doc]: 'editor' });
    const o = await b.open(1, doc);
    expect(o.d).toMatchObject({ head: 4, catchUp: 'reload' });
    const head = await q.stores.logs.head(q.ref(doc));
    expect(head.epoch).toBe(epochBefore + 1);
    const content = await q.plane.readContent(
      q.tokens.identity(q.tokens.issue({ user: 'carol', docs: { [doc]: 'editor' } })),
      doc,
    );
    expect(content.seq).toBe(4);
    expect(JSON.stringify(content.doc)).toContain('3210This agreement');
    // The new owner's first commit continues the log.
    expect((await b.submit(1, { base: 4, steps: [insertText(intro(), 'z')] })).d).toMatchObject({
      seq: 5,
    });
  });

  it('refuses the channel with unavailable when the checkpoint store fails, and serves other rooms', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const other = await p.createDocument();
    const a = await p.client('alice', { [doc]: 'owner', [other]: 'owner' });
    expect((await a.open(1, other)).t).toBe('ch.opened');
    const get = p.checkpoints.get.bind(p.checkpoints);
    p.checkpoints.get = async () => {
      throw new Error('object storage is unavailable');
    };
    expect((await a.open(2, doc)).d).toMatchObject({ code: 'unavailable' });
    expect((await a.submit(1, { base: 0, steps: [insertText(intro(), 'x')] })).t).toBe('sync.ack');
    p.checkpoints.get = get;
    expect((await a.open(2, doc)).t).toBe('ch.opened');
  });

  it('loads grants, region states and leases before the first channel is attached', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    await p.stores.grants.change(
      p.ref(doc),
      {
        setRegionStates: [{ region: 'rTerms000000000A', state: 'approved' }],
        putLeases: [
          { region: 'rNotes000000000C', holder: 'alice', expiresAt: Date.now() + 600_000 },
        ],
      },
      { actor: 'alice' },
    );
    const c = await p.client('carol', { [doc]: 'editor' });
    const o = await c.open(1, doc);
    const access = o.d!['access'];
    expect(access.scopes['region:rTerms000000000A']).toEqual(['view', 'comment']);
    expect(access.leases['region:rNotes000000000C'].holder).toBe('host-alice');
  });

  it('releases ownership after the last channel closed for roomIdleMs (06 §2.2 step 4)', async () => {
    const p = await plane({ settings: { roomIdleMs: 100 } });
    const doc = await p.createDocument();
    const a = await p.client('alice', { [doc]: 'owner' });
    await a.open(1, doc);
    expect((await p.stores.logs.head(p.ref(doc))).owner).not.toBeNull();
    a.send({ t: 'ch.close', ch: 1 });
    await until(() => p.plane.host.get(p.ref(doc)) === undefined, 2000, 'the room to close');
    await new Promise((r) => setTimeout(r, 50));
    expect((await p.stores.logs.head(p.ref(doc))).owner).toBeNull();
    // The next channel opens a new room.
    expect((await a.open(2, doc)).t).toBe('ch.opened');
  });
});

describe('the write pipeline (BE-024, BE-025)', () => {
  it('never has more than one write in flight, and stores what arrived meanwhile in one write', async () => {
    const g = gatedPlane();
    const p = await g.start();
    const doc = await p.createDocument();
    const users = ['alice', 'carol', 'bob', 'mallory'] as const;
    const cs = [];
    for (const u of users) {
      const c = await p.client(u, { [doc]: u === 'alice' ? 'owner' : 'editor' });
      await c.open(1, doc);
      cs.push(c);
    }
    g.gated.hold = true;
    cs[0]!.submitNoWait(1, { base: 0, steps: [insertText(intro(), 'a')] });
    await until(() => g.gated.pending === 1);
    for (const c of cs.slice(1)) c.submitNoWait(1, { base: 0, steps: [insertText(intro(), 'b')] });
    await new Promise((r) => setTimeout(r, 50));
    expect(g.gated.pending).toBe(1);
    await g.gated.release();
    await until(() => g.gated.pending === 1);
    expect(g.gated.requests[1]!.commits.map((c) => c.seq)).toEqual([2, 3, 4]);
    await g.gated.release();
    expect(g.gated.maxInFlight).toBe(1);
    expect((await g.mem.read(p.ref(doc))).map((c) => c.seq)).toEqual([1, 2, 3, 4]);
  });

  it('rejects with unavailable after a failed write and accepts the resubmission', async () => {
    const g = gatedPlane();
    const p = await g.start();
    const doc = await p.createDocument();
    const a = await p.client('alice', { [doc]: 'owner' });
    await a.open(1, doc);
    g.gated.hold = true;
    const id = uuid7();
    const env = a.submitNoWait(1, { id, base: 0, steps: [insertText(intro(), 'x')] });
    await until(() => g.gated.pending === 1);
    await g.gated.release({ status: 'failed' });
    expect((await a.take((m) => m.re === env)).d).toMatchObject({
      id,
      code: 'unavailable',
      action: 'retry',
      head: 0,
    });
    g.gated.hold = false;
    expect((await a.submit(1, { id, base: 0, steps: [insertText(intro(), 'x')] })).d).toMatchObject(
      { id, seq: 1 },
    );
  });

  it('settles an unknown outcome from the log read back: stored is acknowledged, lost is rejected', async () => {
    const g = gatedPlane();
    const p = await g.start();
    const doc = await p.createDocument();
    const ref = p.ref(doc);
    const a = await p.client('alice', { [doc]: 'owner' });
    await a.open(1, doc);
    g.gated.hold = true;
    const stored = a.submitNoWait(1, { base: 0, steps: [insertText(intro(), 'x')] });
    await until(() => g.gated.pending === 1);
    await g.gated.release(async (req) => {
      await g.mem.append(ref, req);
      return { status: 'unknown', tail: await g.mem.read(ref, req.fromSeq) };
    });
    expect((await a.take((m) => m.re === stored)).d).toMatchObject({ seq: 1 });
    const lost = a.submitNoWait(1, { base: 1, steps: [insertText(intro(), 'y')] });
    await until(() => g.gated.pending === 1);
    await g.gated.release(async (req) => ({
      status: 'unknown',
      tail: await g.mem.read(ref, req.fromSeq),
    }));
    expect((await a.take((m) => m.re === lost)).d).toMatchObject({ code: 'unavailable', head: 1 });
  });

  it('stops the room when even the log could not be read back, and opens a new one next', async () => {
    const g = gatedPlane();
    const p = await g.start();
    const doc = await p.createDocument();
    const a = await p.client('alice', { [doc]: 'owner' });
    await a.open(1, doc);
    g.gated.hold = true;
    a.submitNoWait(1, { base: 0, steps: [insertText(intro(), 'x')] });
    await until(() => g.gated.pending === 1);
    await g.gated.release(new OutcomeUnknownError('the database went away'));
    const closed = await a.take((m) => m.t === 'ch.closed');
    expect(closed.d).toMatchObject({ code: 'unavailable' });
    expect(p.plane.host.get(p.ref(doc))).toBeUndefined();
    g.gated.hold = false;
    const again = await a.open(2, doc);
    expect(again.t).toBe('ch.opened');
    expect(p.errors.some((e) => e instanceof OutcomeUnknownError)).toBe(true);
  });

  it('stops serving when another node holds the document, and closes its channels (BE-017, BE-025)', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const a = await p.client('alice', { [doc]: 'owner' });
    await a.open(1, doc);
    await a.submit(1, { base: 0, steps: [insertText(intro(), 'x')] });
    // Node B opens the same document: its claim raises the epoch, so node A's next write is fenced.
    const q = await plane({ stores: p.stores, checkpoints: p.checkpoints, tenant: p.tenant });
    const b = await q.client('carol', { [doc]: 'editor' });
    await b.open(1, doc);
    const r = a.submitNoWait(1, { base: 1, steps: [insertText(intro(), 'y')] });
    const closed = await a.take((m) => m.t === 'ch.closed');
    expect(closed.d).toMatchObject({ code: 'unavailable' });
    expect(a.log.some((m) => m.re === r && m.t === 'sync.ack')).toBe(false);
    expect(p.plane.host.get(p.ref(doc))).toBeUndefined();
    expect((await b.submit(1, { base: 1, steps: [insertText(intro(), 'z')] })).d).toMatchObject({
      seq: 2,
    });
    expect((await p.stores.logs.read(p.ref(doc))).map((c) => c.user)).toEqual(['alice', 'carol']);
  });

  it('closes the channels of a deleted document; reopening finds nothing (BE-035)', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const a = await p.client('alice', { [doc]: 'owner' });
    await a.open(1, doc);
    await (
      p.stores.documents as unknown as { remove: (r: unknown, o: unknown) => Promise<unknown> }
    ).remove(p.ref(doc), { actor: 'alice' });
    p.plane.documentChanged(p.ref(doc));
    expect((await a.take((m) => m.t === 'ch.closed')).d).toMatchObject({ code: 'unavailable' });
    expect((await a.open(2, doc)).d).toMatchObject({ code: 'not_found' });
  });
});
