/**
 * Approval hash check (SEC-030 criterion 3; 07 §11). An approval records the `seq` and the SHA-256 of
 * the region's canonical content at that `seq` (`approvalHash`, states.ts). This module recomputes the
 * hash of a region and compares it with the stored one, and reports each mismatch, so that a region
 * whose content no longer matches its approval is never silently accepted as approved.
 *
 * `verifyRoomApprovals` runs the check over a room: every approval in the room's permission state
 * against the region at the room's durable head (`Room.approvedRegions`). The room host of the
 * document service calls it when a room opens, when permission state arrives, and after a snapshot
 * commit, and writes each mismatch to the audit trail (`region.approval_mismatch`). Nothing here
 * decides what happens after a mismatch.
 */
import type { Node } from 'prosemirror-model';
import type { PermissionState, RegionApproval } from './model.ts';
import { approvalHash } from './states.ts';

export type ApprovalHashCheck =
  | { ok: true; hash: string }
  | { ok: false; code: 'approval_mismatch'; reason: string; expected: string; actual: string };

/** Recomputes the hash of an approved region and compares it with the approval's stored hash. */
export async function checkApprovalHash(
  region: Node,
  approval: RegionApproval,
): Promise<ApprovalHashCheck> {
  const actual = await approvalHash(region);
  if (actual === approval.hash) return { ok: true, hash: actual };
  return {
    ok: false,
    code: 'approval_mismatch',
    reason: `the region's content at seq ${approval.seq} does not match the approved hash`,
    expected: approval.hash,
    actual,
  };
}

/**
 * Checks every approval against the region it names. A region that is missing from the document is
 * reported too, because an approved region that cannot be found cannot be shown to match.
 */
export async function checkApprovals(
  regions: ReadonlyMap<string, Node | null>,
  approvals: ReadonlyMap<string, RegionApproval>,
): Promise<Array<{ region: string; check: Extract<ApprovalHashCheck, { ok: false }> }>> {
  const out: Array<{ region: string; check: Extract<ApprovalHashCheck, { ok: false }> }> = [];
  for (const [id, approval] of approvals) {
    const node = regions.get(id) ?? null;
    if (node === null) {
      out.push({
        region: id,
        check: {
          ok: false,
          code: 'approval_mismatch',
          reason: 'the approved region is not in the document',
          expected: approval.hash,
          actual: '',
        },
      });
      continue;
    }
    const check = await checkApprovalHash(node, approval);
    if (!check.ok) out.push({ region: id, check });
  }
  return out;
}

/** What `verifyRoomApprovals` reads from a room (`Room` has both). */
export interface ApprovalSource {
  readonly permissions: PermissionState;
  approvedRegions(): ReadonlyMap<string, Node | null>;
}

/** A stored approval that does not match the region it names, as `verifyRoomApprovals` reports it. */
export interface ApprovalMismatch {
  region: string;
  /** The `seq` the region was approved at. */
  seq: number;
  /** The stored hash. */
  expected: string;
  /** The hash of the region at the room's durable head; empty when the region is not there. */
  actual: string;
  reason: string;
}

/**
 * Checks every approval in a room's permission state against the region at the room's durable head
 * (07 §11; SEC-030 criterion 3). An empty result means every stored hash matches.
 */
export async function verifyRoomApprovals(room: ApprovalSource): Promise<ApprovalMismatch[]> {
  const approvals = room.permissions.approvals;
  if (!approvals?.size) return [];
  const found = await checkApprovals(room.approvedRegions(), approvals);
  return found.map(({ region, check }) => ({
    region,
    seq: approvals.get(region)!.seq,
    expected: check.expected,
    actual: check.actual,
    reason: check.reason,
  }));
}
