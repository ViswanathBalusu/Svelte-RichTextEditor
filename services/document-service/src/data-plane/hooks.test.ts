/**
 * The fault-injection hooks on the real data plane (BE-079 criteria 3, 4 and 5; 05 §11; 06 §8). The
 * plane runs in test mode over the in-memory stores, which carry out a write fault at the same
 * points as PostgreSQL (`AppendOptions.fault`): before anything is inserted, or after the inserts,
 * which are then undone. The control plane's routes to these hooks are tested in
 * `src/control-plane/test-hooks.test.ts`; `dropDatabase` is tested in `outage.test.ts` and
 * `killRoom` in `test/data-plane/session-1b.test.ts`.
 *
 * The PostgreSQL side of the same faults (`PgLogStore.append` with `fault`) needs a database and
 * is not run here.
 */
import { uuid7 } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { insertText } from '../../test/data-plane/client.ts';
import { memoryStores, startPlane, until, type Plane } from '../../test/data-plane/support.ts';
import { chainHash, encodeCommit } from '../storage/codec.ts';
import { MemoryStore } from '../storage/memory.ts';
import type { AppendOptions, DocRef, WriteFault } from '../storage/types.ts';
import { MemoryAudit } from './memory-ports.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');
const NODE = 'node-hooks';

/** The memory store, recording the fault each write was given. */
class RecordingStore extends MemoryStore {
  readonly faults: Array<WriteFault | undefined> = [];
  override append(...args: Parameters<MemoryStore['append']>) {
    const options: AppendOptions | undefined = args[2];
    this.faults.push(options?.fault);
    return super.append(...args);
  }
}

let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

async function testPlane() {
  const memory = new RecordingStore();
  const audit = new MemoryAudit();
  const p = await startPlane({
    stores: {
      ...memoryStores(),
      logs: memory,
      ownership: memory,
      grants: memory,
      documents: memory,
    },
    settings: { testMode: true },
    deps: { audit },
    node: NODE,
  });
  planes.push(p);
  return { p, memory, audit, hooks: p.plane.hooks! };
}

/** The chain head of `ref` recomputed from the stored log, as `docedit verify` walks it. */
async function chainOf(memory: MemoryStore, ref: DocRef): Promise<string | null> {
  let prev: Buffer | null = null;
  for (const c of await memory.read(ref)) {
    const e = encodeCommit(ref.doc, c);
    prev = chainHash(prev, e.metaBytes, e.payloadHash);
  }
  return prev ? prev.toString('hex') : null;
}

describe('fault hooks on the real data plane (BE-079)', () => {
  it('fails the next write before its insert: the commit is rejected as retryable, nothing is stored, and the next write succeeds [neg:code unavailable]', async () => {
    const { p, memory, hooks } = await testPlane();
    const doc = await p.createDocument();
    const ref = p.ref(doc);
    const a = await p.client('alice', { [doc]: 'owner' });
    await a.open(1, doc);

    hooks.failNextWrite(ref, 'before-insert');
    const id = uuid7();
    const writes = memory.faults.length;
    const r = await a.submit(1, { id, base: 0, steps: [insertText(intro(), 'one')] });
    expect(r.t).toBe('sync.reject');
    expect(r.d).toMatchObject({ id, code: 'unavailable', action: 'retry' });
    expect(memory.faults.slice(writes)).toEqual(['before-insert']);
    expect(await memory.read(ref)).toHaveLength(0);
    expect(await hooks.state(ref)).toMatchObject({ seq: 0, chainHead: null });

    // The fault is used once: the same commit sent again is stored.
    const ok = await a.submit(1, { id, base: 0, steps: [insertText(intro(), 'one')] });
    expect(ok.t).toBe('sync.ack');
    expect(ok.d).toMatchObject({ id, seq: 1 });
    expect(memory.faults.slice(writes)).toEqual(['before-insert', undefined]);
    expect((await memory.read(ref)).map((c) => c.id)).toEqual([id]);
    expect(a.closeInfo).toBeNull();
  });

  it('fails the next write after its insert: the insert is undone, the head and chain head are as before, and the next write succeeds', async () => {
    const { p, memory, hooks } = await testPlane();
    const doc = await p.createDocument();
    const ref = p.ref(doc);
    const a = await p.client('alice', { [doc]: 'owner' });
    await a.open(1, doc);
    expect((await a.submit(1, { base: 0, steps: [insertText(intro(), 'one')] })).t).toBe(
      'sync.ack',
    );
    const before = await hooks.state(ref);
    expect(before.seq).toBe(1);

    hooks.failNextWrite(ref, 'after-insert');
    const id = uuid7();
    const r = await a.submit(1, { id, base: 1, steps: [insertText(intro(), 'two')] });
    expect(r.t).toBe('sync.reject');
    expect(r.d).toMatchObject({ id, code: 'unavailable', action: 'retry' });
    expect(memory.faults.at(-1)).toBe('after-insert');
    expect(await hooks.state(ref)).toEqual(before);
    expect((await memory.read(ref)).map((c) => c.seq)).toEqual([1]);

    const ok = await a.submit(1, { id, base: 1, steps: [insertText(intro(), 'two')] });
    expect(ok.d).toMatchObject({ id, seq: 2 });
    expect((await memory.read(ref)).map((c) => c.seq)).toEqual([1, 2]);
  });

  it('drops exactly one grant announcement: the room keeps its permissions until the next one', async () => {
    const { p, hooks } = await testPlane();
    const doc = await p.createDocument();
    const ref = p.ref(doc);
    const frank = await p.client('frank', { [doc]: 'viewer' });
    await frank.open(1, doc);
    const revision = () => p.plane.host.get(ref)!.permissions.revision;
    const grant = (user: string) => ({
      putGrants: [
        {
          region: 'rNotes000000000C',
          principal: `user:${user}`,
          role: 'viewer' as const,
          expiresAt: null,
        },
      ],
    });
    expect(revision()).toBe(1);

    hooks.dropNextAnnouncement(ref);
    const dropped = await p.changeGrants(doc, grant('u1'));
    expect(dropped.revision).toBe(2);
    await new Promise((r) => setTimeout(r, 100));
    // The room was not told: no control commit, no perm.changed, the old revision in force.
    expect(frank.all('perm.changed', 1)).toHaveLength(0);
    expect((await p.stores.logs.read(ref)).some((c) => c.kind === 'control')).toBe(false);
    expect(revision()).toBe(1);

    // Only one is dropped: the next announcement reaches the room with the newest grants.
    await p.changeGrants(doc, grant('u2'));
    await until(() => frank.all('perm.changed', 1).length >= 1, 3000, 'perm.changed');
    await new Promise((r) => setTimeout(r, 100));
    expect(frank.all('perm.changed', 1)).toHaveLength(1);
    expect(revision()).toBe(3);
    // One control commit, at grants revision 3: revision 2 was never announced to the room.
    const controls = frank
      .all('sync.commit', 1)
      .flatMap((m) => m.d!['commits'] as Array<{ kind: string; control?: { rev: number } }>)
      .filter((c) => c.kind === 'control');
    expect(controls.map((c) => c.control?.rev)).toEqual([3]);
  });

  it('reads the chain head, the ownership epoch and the audit events of a document, and records each change hook in the audit trail (criteria 4, 5)', async () => {
    const { p, memory, audit, hooks } = await testPlane();
    const doc = await p.createDocument();
    const ref = p.ref(doc);

    // Before the room opens: no commit, no owner.
    const initial = await hooks.state(ref);
    expect(initial).toMatchObject({ seq: 0, epoch: 0, owner: null, chainHead: null });

    const a = await p.client('alice', { [doc]: 'owner' });
    await a.open(1, doc);
    for (let i = 0; i < 3; i++)
      expect((await a.submit(1, { base: i, steps: [insertText(intro(), `t${i}`)] })).t).toBe(
        'sync.ack',
      );
    const state = await hooks.state(ref);
    // The room claimed the document, so this node owns it at a higher epoch.
    expect(state).toMatchObject({ seq: 3, owner: NODE, incarnation: initial.incarnation });
    expect(state.epoch).toBeGreaterThan(initial.epoch);
    expect(state.epoch).toBe((await memory.head(ref)).epoch);
    // The chain head is the hash of the last commit, chained from the first (08 §2).
    expect(state.chainHead).toMatch(/^[0-9a-f]{64}$/);
    expect(state.chainHead).toBe(await chainOf(memory, ref));

    // A change hook is recorded in the audit trail; a read is not.
    hooks.failNextWrite(ref, 'after-insert');
    hooks.dropNextAnnouncement(ref);
    await until(
      () => audit.events.filter((e) => e.kind === 'test.hook').length === 2,
      3000,
      'the audit events of the hooks',
    );
    const events = await hooks.auditEvents(ref);
    const used = events.filter((e) => e.kind === 'test.hook');
    expect(used.map((e) => e.data)).toEqual([
      { hook: 'failNextWrite', at: 'after-insert' },
      { hook: 'dropNextAnnouncement' },
    ]);
    expect(used.every((e) => e.doc === doc && e.tenant === p.tenant && e.actor === 'system')).toBe(
      true,
    );
    // auditEvents returns the document's events as the audit store holds them.
    expect(events).toEqual(await audit.query(p.tenant, { doc, limit: 1000 }));

    // Every use, reads included, is logged (criterion 5).
    const logged = p.errors
      .map((e) => e as { event?: string; hook?: string })
      .filter((e) => e.event === 'data-plane.test-hook')
      .map((e) => e.hook);
    expect(logged).toEqual([
      'state',
      'state',
      'failNextWrite',
      'dropNextAnnouncement',
      'auditEvents',
    ]);
  });
});
