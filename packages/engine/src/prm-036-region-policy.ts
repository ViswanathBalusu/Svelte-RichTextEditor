/**
 * `setRegionPolicy` (PRM-036 criterion 1, lane V-PRM-035-051): the region with the given identifier
 * takes the given policy (`inherit` or `restricted`) in one transaction. The change is a policy
 * change, which the region guard (`guard.ts`, P2) refuses without `manage`; the command itself is
 * refused when `allowed` is false (the user lacks `manage`), when no region has the identifier, or
 * when the region already has that policy (nothing to change, so nothing is queued).
 */
import type { Command } from 'prosemirror-state';

export type RegionPolicy = 'inherit' | 'restricted';

export function setRegionPolicy(region: string, policy: RegionPolicy, allowed: boolean): Command {
  return (state, dispatch) => {
    if (!allowed) return false;
    let found: { pos: number; policy: unknown } | null = null;
    state.doc.descendants((node, pos) => {
      if (found !== null) return false;
      if (node.type.name === 'region' && node.attrs['id'] === region)
        found = { pos, policy: node.attrs['policy'] };
      return found === null;
    });
    const hit = found as { pos: number; policy: unknown } | null;
    if (hit === null || hit.policy === policy) return false;
    if (dispatch) {
      const node = state.doc.nodeAt(hit.pos);
      if (!node) return false;
      dispatch(
        state.tr.setNodeMarkup(hit.pos, undefined, { ...node.attrs, policy }).scrollIntoView(),
      );
    }
    return true;
  };
}
