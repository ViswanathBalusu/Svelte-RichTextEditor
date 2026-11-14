/**
 * SEC-030 criterion 3 (10 §3.3; 07 §11): given the approval record, the region's canonical content
 * hashes to the stored hash, and a mismatch is reported.
 *
 * Every approval here is the record the room produces: `room.regionApproval(...)` gives the `seq`
 * and the canonical text, and `sha256Hex(canonical)` the hash, as the control plane stores it. It is
 * then set through `setRegionState` and handed to the room with `permissionsChanged`.
 *
 * - The room (packages/authority): `verifyRoomApprovals` checks the approvals in the room's
 *   permission state against the region at its durable head (`Room.approvedRegions`). A matching
 *   approval gives nothing. A room opened on a document whose approved region was altered after the
 *   approval, on one where the region is gone, and a stored hash that was changed, are each
 *   reported with the region, the approved `seq` and both hashes.
 * - The document service: the room host runs the check when permission state arrives and writes a
 *   mismatch to the audit trail as `region.approval_mismatch` (room-host.ts, `#verifyApprovals`).
 *   The real data plane runs over the in-memory stores with an in-memory audit store.
 *
 * Node.js only. No Podman, no PostgreSQL. Not covered: the grant stores of the document service do
 * not keep approvals yet (handlers.ts, `setRegionState`: storing them is PRM's, phase 2), so a room
 * opened from storage has none to check; the host's check at open is run here only through the
 * room (the same `verifyRoomApprovals`), and in the service through `permissionsChanged`.
 */
import { sha256Hex } from '@docedit/model';
import { Fragment, type Node, Slice } from 'prosemirror-model';
import { ReplaceStep, Transform } from 'prosemirror-transform';
import { afterEach, describe, expect, it } from 'vitest';
import {
  verifyRoomApprovals,
  type ApprovalMismatch,
} from '../../../packages/authority/src/index.ts';
import { computeAccess } from '../../../packages/authority/src/permissions/access.ts';
import type {
  PermissionState,
  RegionApproval,
} from '../../../packages/authority/src/permissions/model.ts';
import {
  regionCanonicalText,
  setRegionState,
} from '../../../packages/authority/src/permissions/states.ts';
import { regionInfos } from '../../../packages/authority/src/permissions/visibility.ts';
import type { Room } from '../../../packages/authority/src/room/room.ts';
import type { Effects } from '../../../packages/authority/src/room/types.ts';
import { stepsToJson } from '../../../packages/authority/src/steps.ts';
import {
  USERS,
  baseDoc,
  basePermissions,
  posInside,
  posOf,
  schema,
} from '../../../packages/authority/test/fixtures.ts';
import { commitId, roomWith } from '../../../packages/authority/test/permission-fixtures.ts';
import { MemoryAudit } from '../../../services/document-service/src/data-plane/memory-ports.ts';
import {
  startPlane,
  until,
  type Plane,
} from '../../../services/document-service/test/data-plane/support.ts';

const TERMS = 'rTerms000000000A';
const PARA = 'pTerms000000001A';
const NOW = 1_770_700_000_000;

/** Stores the write `fx` asks for, and every write that follows it. */
function store(room: Room, fx: Effects): void {
  for (let w = fx.write; w; w = room.writeCompleted({ status: 'ok' }).write);
}

/** Carol (an editor of the region) types into it; the commit is stored when the room accepts it. */
function typeIntoRegion(room: Room, text: string): Effects {
  const pos = posInside(room.document, PARA);
  const step = new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text(text)), 0, 0));
  const fx = room.submit('c1', { id: commitId(), base: room.head, steps: stepsToJson([step]) });
  store(room, fx);
  return fx;
}

/** The approval the control plane stores: the room's `seq` and the SHA-256 of its canonical text. */
async function approvalOf(room: Room, region = TERMS): Promise<RegionApproval> {
  const basis = room.regionApproval(region);
  if (!basis) throw new Error(`the room offers no approval of ${region}`);
  return { seq: basis.seq, hash: await sha256Hex(basis.canonical) };
}

/** The permission state after an owner approves `region` with `approval` (07 §11; setRegionState). */
function approvedState(
  doc: Node,
  perms: PermissionState,
  approval: RegionApproval,
): PermissionState {
  const v = setRegionState({
    access: computeAccess(USERS.alice, regionInfos(doc), perms, NOW),
    perms,
    region: TERMS,
    exists: true,
    state: 'approved',
    approval,
  });
  if (!v.ok) throw new Error(v.reason);
  return {
    ...perms,
    revision: perms.revision + 1,
    regionStates: v.regionStates,
    approvals: v.approvals,
  };
}

const hashOfRegion = async (doc: Node): Promise<string> =>
  sha256Hex(regionCanonicalText(doc.nodeAt(posOf(doc, TERMS))!));

describe('SEC-030 criterion 3: the room checks its stored approvals', () => {
  it('reports nothing when the stored hash is the hash of the region the room approved', async () => {
    const room = roomWith(baseDoc(), basePermissions(), () => NOW);
    room.open('c1', USERS.carol);
    typeIntoRegion(room, 'Agreed: ');
    const approval = await approvalOf(room);
    expect(approval.seq).toBe(1);
    store(room, room.permissionsChanged(approvedState(room.document, room.permissions, approval)));
    expect(room.permissions.approvals?.get(TERMS)).toEqual(approval);
    expect([...room.approvedRegions().keys()]).toEqual([TERMS]);
    expect(await verifyRoomApprovals(room)).toEqual([]);
    // The approved region refuses the change, so the check still matches afterwards.
    const refused = typeIntoRegion(room, 'Later: ');
    expect(refused.write).toBeNull();
    expect(await verifyRoomApprovals(room)).toEqual([]);
  });

  it('reports a room opened on a document whose approved region was altered after the approval', async () => {
    const first = roomWith(baseDoc(), basePermissions(), () => NOW);
    const approval = await approvalOf(first);
    const perms = approvedState(first.document, first.permissions, approval);
    // The stored approval is loaded with content that differs inside the region (a stored row
    // edited, or a restore that bypassed the room).
    const altered = new Transform(baseDoc()).insert(
      posInside(baseDoc(), PARA),
      schema.text('Changed '),
    ).doc;
    const reopened = roomWith(altered, perms, () => NOW);
    const found = await verifyRoomApprovals(reopened);
    expect(found).toEqual<ApprovalMismatch[]>([
      {
        region: TERMS,
        seq: approval.seq,
        expected: approval.hash,
        actual: await hashOfRegion(altered),
        reason: expect.stringMatching(/does not match the approved hash/) as unknown as string,
      },
    ]);
    expect(found[0]!.actual).not.toBe(approval.hash);
    // Control: the same approval over the unaltered content reports nothing.
    expect(await verifyRoomApprovals(roomWith(baseDoc(), perms, () => NOW))).toEqual([]);
  });

  it('reports an approved region that is not in the document', async () => {
    const first = roomWith(baseDoc(), basePermissions(), () => NOW);
    const approval = await approvalOf(first);
    const perms = approvedState(first.document, first.permissions, approval);
    const doc = baseDoc();
    const at = posOf(doc, TERMS);
    const without = new Transform(doc).delete(at, at + doc.nodeAt(at)!.nodeSize).doc;
    const found = await verifyRoomApprovals(roomWith(without, perms, () => NOW));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      region: TERMS,
      seq: approval.seq,
      expected: approval.hash,
      actual: '',
    });
    expect(found[0]!.reason).toMatch(/not in the document/);
  });

  it('reports a stored hash that was changed after the approval', async () => {
    const room = roomWith(baseDoc(), basePermissions(), () => NOW);
    const approval = await approvalOf(room);
    const perms = approvedState(room.document, room.permissions, approval);
    store(room, room.permissionsChanged(perms));
    expect(await verifyRoomApprovals(room)).toEqual([]);
    const forged = {
      seq: approval.seq,
      hash: approval.hash.replace(/^./, (c) => (c === '0' ? '1' : '0')),
    };
    store(
      room,
      room.permissionsChanged({
        ...perms,
        revision: perms.revision + 1,
        approvals: new Map([[TERMS, forged]]),
      }),
    );
    const found = await verifyRoomApprovals(room);
    expect(found.map((m) => [m.region, m.expected, m.actual])).toEqual([
      [TERMS, forged.hash, approval.hash],
    ]);
  });
});

describe('SEC-030 criterion 3: the room host writes a mismatch to the audit trail', () => {
  let planes: Plane[] = [];
  afterEach(async () => {
    for (const p of planes) await p.close();
    planes = [];
  });

  const mismatches = (audit: MemoryAudit, tenant: string, doc: string) =>
    audit.query(tenant, { doc, kind: 'region.approval_mismatch', limit: 1000 });

  it('records region.approval_mismatch for an approval that does not match the room, and nothing for one that does', async () => {
    const audit = new MemoryAudit();
    const p = await startPlane({ deps: { audit } });
    planes.push(p);
    const doc = await p.createDocument();
    const ref = p.ref(doc);
    const alice = await p.client('alice', { [doc]: 'owner' });
    expect((await alice.open(1, doc)).t).toBe('ch.opened');
    const hosted = p.plane.host.get(ref);
    expect(hosted).toBeDefined();

    // The approval record of the room for the same content (the plane's fixture document).
    const local = roomWith(baseDoc(), basePermissions(), () => NOW);
    const approval = await approvalOf(local);
    expect(approval.hash).toBe(await hashOfRegion(baseDoc()));

    // 1. A matching approval: the state change is stored, then the room is told with the approval.
    const ok = await p.changeGrants(
      doc,
      { setRegionStates: [{ region: TERMS, state: 'approved' }] },
      false,
    );
    p.plane.permissionsChanged(ref, { ...ok, approvals: new Map([[TERMS, approval]]) });
    await until(
      () => hosted!.permissions.approvals?.get(TERMS)?.hash === approval.hash,
      3000,
      'approval',
    );
    // The check is asynchronous and the auditor writes on a timer: give both time, then look. (The
    // auditor's flush() is not called on an empty queue; see the lane report.)
    await new Promise((r) => setTimeout(r, 100));
    expect(p.plane.audit.queued).toBe(0);
    expect(await mismatches(audit, p.tenant, doc)).toEqual([]);
    expect(p.errors).toEqual([]);

    // 2. An approval of altered content (the region as it was after an edit the room never had).
    local.open('c1', USERS.carol);
    typeIntoRegion(local, 'Changed ');
    const stale = await approvalOf(local);
    expect(stale.hash).not.toBe(approval.hash);
    const next = await p.changeGrants(
      doc,
      { setRegionStates: [{ region: TERMS, state: 'approved' }] },
      false,
    );
    p.plane.permissionsChanged(ref, { ...next, approvals: new Map([[TERMS, stale]]) });
    await until(
      () => audit.events.some((e) => e.kind === 'region.approval_mismatch'),
      3000,
      'audit row',
    );
    const rows = await mismatches(audit, p.tenant, doc);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenant: p.tenant,
      doc,
      actor: 'system',
      kind: 'region.approval_mismatch',
      data: { region: TERMS, seq: stale.seq, expected: stale.hash, actual: approval.hash },
    });
    expect(
      p.errors.some(
        (e) => e instanceof Error && /approval of region rTerms000000000A/.test(e.message),
      ),
    ).toBe(true);
  });
});
