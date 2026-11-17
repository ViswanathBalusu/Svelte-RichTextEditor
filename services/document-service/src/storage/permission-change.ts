/**
 * The change between two permission states, as plain data (07 §9). It needs no store, so the
 * handlers of the control API use it without importing a PostgreSQL adapter (BE-002 criterion 1);
 * `grant-store.ts` re-exports it.
 */
import type { PermissionState } from '@docedit/authority';
import type { PermissionChange } from './types.ts';

/** The change that turns `from` into `to`, for callers that hold a whole desired state. */
export function diffPermissions(
  from: PermissionState,
  to: Omit<PermissionState, 'revision'>,
): PermissionChange {
  const key = (g: { region: string; principal: string }) => `${g.region}\u0000${g.principal}`;
  const before = new Map(from.grants.map((g) => [key(g), g]));
  const after = new Map(to.grants.map((g) => [key(g), g]));
  const change: PermissionChange = {
    removeGrants: [...before.values()]
      .filter((g) => !after.has(key(g)))
      .map((g) => ({ region: g.region, principal: g.principal })),
    putGrants: [...after.values()].filter((g) => {
      const b = before.get(key(g));
      return !b || b.role !== g.role || b.expiresAt !== g.expiresAt;
    }),
    clearRegionStates: [...from.regionStates.keys()].filter((r) => !to.regionStates.has(r)),
    setRegionStates: [...to.regionStates.entries()]
      .filter(([r, s]) => from.regionStates.get(r) !== s)
      .map(([region, state]) => ({ region, state })),
    removeLeases: from.leases
      .filter((l) => !to.leases.some((m) => m.region === l.region))
      .map((l) => l.region),
    putLeases: to.leases.filter(
      (l) =>
        !from.leases.some(
          (m) => m.region === l.region && m.holder === l.holder && m.expiresAt === l.expiresAt,
        ),
    ),
  };
  if (to.documentState !== from.documentState) change.documentState = to.documentState;
  if (to.workflowActive !== from.workflowActive) change.workflowActive = to.workflowActive;
  return change;
}
