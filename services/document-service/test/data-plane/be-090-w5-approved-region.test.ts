// BE-090 criterion 2 (06 section 11; 07 section 11; lane w5): a repair commit passes the same
// authority checks as any commit, and one that would change an approved region is refused until the
// region's state is changed. A document is damaged on purpose: a checkpoint at seq 2 holds the
// content of seq 0, so the room that opens from it holds content without the two edits the log
// has, one of them in the Terms region. With the Terms region approved, the repair (the content the
// log replays to) would change that region, so the room refuses the snapshot; once the region is
// back in review the same procedure succeeds. The real data plane runs over the in-memory stores
// (test/data-plane/support.ts); the PostgreSQL run of the procedure is be-090-repair.pg.test.ts.
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { MemoryAudit, MemoryOutbox } from '../../src/data-plane/memory-ports.ts';
import { Metrics } from '../../src/data-plane/metrics.ts';
import { OutboxDelivery } from '../../src/data-plane/outbox.ts';
import { rebuild, type RecoveryStores } from '../../src/data-plane/recovery.ts';
import { enqueueRepair, planRepair } from '../../src/data-plane/repair.ts';
import { settingsFrom } from '../../src/data-plane/settings.ts';
import { Tracer } from '../../src/data-plane/tracing.ts';
import { insertText } from './client.ts';
import { startPlane, type Plane } from './support.ts';

const TERMS_ID = 'rTerms000000000A';

/** The position inside the first text block of a region of the fixture document. */
function insideRegion(rid: string): number {
  let inside = -1;
  baseDoc().descendants((node, pos) => {
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
  if (inside < 0) throw new Error(`no text block in region ${rid}`);
  return inside;
}

let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close().catch(() => {});
  planes = [];
});

describe('a repair that would change an approved region is refused (BE-090 criterion 2)', () => {
  it('is refused while the region is approved, applied once it is in review, and the audit trail keeps both plans', async () => {
    // The first node writes the document: one edit in the Terms region, one in the introduction.
    const first = await startPlane();
    planes.push(first);
    const doc = await first.createDocument();
    const ref = first.ref(doc);
    const alice = await first.client('alice', { [doc]: 'owner' });
    await alice.open(1, doc);
    const edits = [
      insertText(insideRegion(TERMS_ID), 'terms edit'),
      insertText(posInside(baseDoc(), 'pIntro0000000001'), 'intro edit'),
    ];
    for (let i = 0; i < edits.length; i++)
      expect((await alice.submit(1, { base: i, steps: [edits[i]!] })).t).toBe('sync.ack');
    const { stores, checkpoints, tenant } = first;
    await first.close();

    // The damage: a checkpoint at seq 2 with the content of seq 0, which the log does not produce.
    await checkpoints.put(ref, 2, (await checkpoints.get(ref, 0))!);
    const recovery: RecoveryStores = { logs: stores.logs, checkpoints };

    // A node that opens the document now starts from the damaged checkpoint.
    const second = await startPlane({ stores, checkpoints, tenant });
    planes.push(second);
    const owner = await second.client('alice', { [doc]: 'owner' });
    await owner.open(1, doc);
    await second.changeGrants(doc, { setRegionStates: [{ region: TERMS_ID, state: 'approved' }] });
    await owner.take((m) => m.t === 'perm.changed');

    const outbox = new MemoryOutbox(() => Date.now());
    const audit = new MemoryAudit();
    const delivery = new OutboxDelivery({
      store: outbox,
      host: second.plane.host,
      node: 'node-w5',
      settings: settingsFrom({
        onError: (e) => second.errors.push(e),
        outbox: { pollMs: 60_000, leaseMs: 1_000, batch: 20 },
      }),
      metrics: new Metrics('node-w5'),
      tracer: new Tracer(undefined),
    });
    const headBefore = (await stores.logs.head(ref)).seq;

    // While approved: the plan is made, the item is delivered, and the room refuses it.
    const plan = await planRepair(recovery, ref, { operator: 'operator-w5', reason: 'damaged' });
    // The head is 3: the two edits and the control commit of the approval (07 section 9).
    expect(plan).toMatchObject({ head: headBefore, from: 0, changes: true });
    const refusedItem = await enqueueRepair({ plan, outbox, audit });
    await delivery.poll();
    const refused = await outbox.get(ref.tenant, refusedItem.id);
    expect(refused?.state).toBe('failed');
    expect(refused?.result).toMatchObject({
      code: 'forbidden',
      // The room names the region it will not change; the same procedure succeeds below once the
      // region's state is changed, so the state is the cause.
      message: expect.stringContaining(TERMS_ID),
    });
    expect((await stores.logs.head(ref)).seq).toBe(headBefore);
    expect((await stores.logs.read(ref, 1, headBefore)).some((c) => c.origin === 'repair')).toBe(
      false,
    );

    // The region leaves approved: the same procedure now succeeds, as an ordinary commit.
    await second.changeGrants(doc, { setRegionStates: [{ region: TERMS_ID, state: 'in_review' }] });
    await owner.take((m) => m.t === 'perm.changed' && m.d!['rev'] !== undefined);
    // The change of state is a control commit too, so the head has moved by one.
    const headNow = (await stores.logs.head(ref)).seq;
    expect(headNow).toBe(headBefore + 1);
    const again = await planRepair(recovery, ref, { operator: 'operator-w5', reason: 'approved' });
    expect(again).toMatchObject({ head: headNow, changes: true });
    const item = await enqueueRepair({ plan: again, outbox, audit });
    await delivery.poll();
    expect(await outbox.get(ref.tenant, item.id)).toMatchObject({
      state: 'done',
      result: { seq: headNow + 1 },
    });
    const [commit] = await stores.logs.read(ref, headNow + 1, headNow + 1);
    expect(commit).toMatchObject({ origin: 'repair', user: 'system' });
    expect((await rebuild(recovery, ref)).hash).toBe(again.targetHash);

    // Both attempts are in the audit trail with the operator and the reason.
    const events = (await audit.query(ref.tenant, { doc, limit: 100 })).filter(
      (e) => e.kind === 'repair.enqueued',
    );
    expect(events.map((e) => e.data['reason'])).toEqual(
      expect.arrayContaining(['damaged', 'approved']),
    );
    expect(events.every((e) => e.actor === 'operator-w5')).toBe(true);
  });
});
