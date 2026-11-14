/**
 * BE-039 criterion 6 (lane BE-027-039, round 3): a server-authored operation that would change an
 * approved region is refused by the room (PRM-046, PRM-047; 07 §11), and nothing is stored. The
 * outbox hands the item to the real `RoomHost.apply` over the in-memory stores (as
 * be-039-outbox-room.test.ts does); the approval is set through the room's own grant change. No
 * PostgreSQL and no browser is used.
 */
import { uuid7 } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc } from '../../../../packages/authority/test/fixtures.ts';
import { insertText } from '../../test/data-plane/client.ts';
import { startPlane, type Plane } from '../../test/data-plane/support.ts';
import type { DocRef, NewOutboxItem } from '../storage/types.ts';
import { MemoryOutbox } from './memory-ports.ts';
import { Metrics } from './metrics.ts';
import { OutboxDelivery } from './outbox.ts';
import { settingsFrom } from './settings.ts';
import { Tracer } from './tracing.ts';

const TERMS_ID = 'rTerms000000000A';

/** The position inside the first text block of region `rid` of the fixture document. */
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
  if (inside < 0) throw new Error(`no text block in region ${rid}`);
  return inside;
}

let planes: Plane[] = [];
async function plane(): Promise<Plane> {
  const p = await startPlane();
  planes.push(p);
  return p;
}
const started: OutboxDelivery[] = [];
afterEach(async () => {
  for (const d of started.splice(0)) await d.stop();
  for (const p of planes) await p.close();
  planes = [];
});

/** An outbox item for a server-authored step commit that edits region `rid` (origin `prefill`). */
function editItem(ref: DocRef, commitId: string, rid: string, text: string): NewOutboxItem {
  return {
    tenant: ref.tenant,
    doc: ref.doc,
    commitId,
    kind: 'author',
    request: {
      origin: 'prefill',
      actor: 'system',
      base: 0,
      steps: [insertText(insideRegion(rid), text)],
    },
  };
}

function deliveryFor(store: MemoryOutbox, p: Plane, node: string): OutboxDelivery {
  const d = new OutboxDelivery({
    store,
    host: p.plane.host,
    node,
    settings: settingsFrom({
      onError: (e) => p.errors.push(e),
      outbox: { pollMs: 60_000, leaseMs: 1_000, batch: 20 },
    }),
    metrics: new Metrics(node),
    tracer: new Tracer(undefined),
  });
  started.push(d);
  return d;
}

describe('a server-authored operation is refused for an approved region (BE-039 criterion 6)', () => {
  it('refuses an outbox item that would change an approved region and stores nothing, then applies it once the region leaves approved', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const ref = p.ref(doc);
    const store = new MemoryOutbox(() => 0);
    const d = deliveryFor(store, p, 'node-a');

    await p.changeGrants(doc, { setRegionStates: [{ region: TERMS_ID, state: 'approved' }] });
    const refused = await store.enqueue(editItem(ref, uuid7(), TERMS_ID, 'Changed'));
    const outcome = await d.outcome(refused, 2_000);
    expect(outcome).toMatchObject({
      state: 'failed',
      syncCode: 'permission_denied',
      action: 'drop',
    });
    expect(await store.get(ref.tenant, refused.id)).toMatchObject({ state: 'failed' });
    expect((await p.stores.logs.head(ref)).seq).toBe(0);
    expect(await p.stores.logs.read(ref, 1, 5)).toHaveLength(0);

    // The same kind of operation is applied once the region is no longer approved, so the refusal
    // came from the approval and not from the item.
    await p.changeGrants(doc, { setRegionStates: [{ region: TERMS_ID, state: 'in_review' }] });
    const allowed = await store.enqueue(editItem(ref, uuid7(), TERMS_ID, 'Allowed'));
    await d.poll();
    expect(await store.get(ref.tenant, allowed.id)).toMatchObject({
      state: 'done',
      result: { seq: 1 },
    });
    expect((await p.stores.logs.head(ref)).seq).toBe(1);
    expect(p.errors).toEqual([]);
  });
});
