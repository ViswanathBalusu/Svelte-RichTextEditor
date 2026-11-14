/**
 * Region states (07 §11; PRM-046, PRM-047; ADR 0050 item 7). `draft` and `in_review` are labels;
 * `approved` freezes the region for everyone (07 §4 limit 2). An approval is bound to what was
 * approved: the state record holds the `seq` and the SHA-256 of the region's canonical content at
 * that `seq`, computed by the room from its own document, never taken from the client.
 *
 * The canonical content of an approval excludes the values of form fields (second review SR-M25):
 * fills under P7 and server commits with origin `sign` or `rules` may change values inside an
 * approved region, and must not break the approval.
 */
import { canonicalNodeText, sha256Hex, type JsonNode } from '@docedit/model';
import { FILL_ATTRIBUTES } from '@docedit/model/definition';
import type { Node } from 'prosemirror-model';
import type { Access } from './access.ts';
import type { PermissionState, RegionApproval, RegionState } from './model.ts';

export type { RegionApproval } from './model.ts';

function withoutValues(json: JsonNode): JsonNode {
  const out: JsonNode = { ...json };
  if (json.type === 'form_field' && json.attrs) {
    const attrs = { ...json.attrs };
    for (const a of FILL_ATTRIBUTES) Reflect.deleteProperty(attrs, a);
    out.attrs = attrs;
  }
  if (json.content) out.content = json.content.map(withoutValues);
  return out;
}

/** The canonical text of a region's content for its approval (07 §11; SR-M25: no field values). */
export function regionCanonicalText(region: Node): string {
  return canonicalNodeText(withoutValues(region.toJSON() as JsonNode));
}

/** The hash an approval of this region records (07 §11). */
export function approvalHash(region: Node): Promise<string> {
  return sha256Hex(regionCanonicalText(region));
}

export type StateVerdict =
  | {
      ok: true;
      regionStates: ReadonlyMap<string, RegionState>;
      approvals: ReadonlyMap<string, RegionApproval>;
    }
  | { ok: false; code: 'permission_denied' | 'not_found' | 'invalid_op'; reason: string };

export interface StateChange {
  /** The caller's access (a state change needs `manage`, 07 §2, §11). */
  access: Access;
  perms: PermissionState;
  region: string;
  /** Whether the region exists at the head and its identifier is not retired. */
  exists: boolean;
  state: RegionState;
  /** For `approved`: the room's record of what is approved (`Room.regionApproval`). */
  approval?: RegionApproval;
}

/**
 * The decision of `PUT /documents/{id}/regions/{rid}/state` (07 §11, §12 row 10): `manage`, a
 * region that exists, and for `approved` the room's binding. Returns the new region states and
 * approvals for the control plane to store under a new grants revision.
 */
export function setRegionState(c: StateChange): StateVerdict {
  if (!c.access.docRole.has('manage'))
    return { ok: false, code: 'permission_denied', reason: '`region_state.change` needs `manage`' };
  if (!c.exists) return { ok: false, code: 'not_found', reason: `no region ${c.region}` };
  if (!['draft', 'in_review', 'approved'].includes(c.state))
    return { ok: false, code: 'invalid_op', reason: `"${String(c.state)}" is not a region state` };
  if (c.state === 'approved' && !c.approval)
    return {
      ok: false,
      code: 'invalid_op',
      reason: 'an approval records the seq and hash the room computed (07 §11)',
    };
  const regionStates = new Map(c.perms.regionStates);
  const approvals = new Map(c.perms.approvals ?? []);
  if (c.state === 'draft') regionStates.delete(c.region);
  else regionStates.set(c.region, c.state);
  if (c.state === 'approved') approvals.set(c.region, c.approval!);
  else approvals.delete(c.region);
  return { ok: true, regionStates, approvals };
}
