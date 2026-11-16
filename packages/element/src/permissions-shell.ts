/**
 * The shell's region list and grants service over the backend's permissions port (PRO-080
 * criterion 2; the pane is PRM-032 and PRM-035). The shell offers its permissions pane only when
 * the core has a region list, and its grant controls only when it has a grants service; both are
 * read from the backend here, so the element holds no copy of the rules.
 *
 * The list is read when the pane first asks and again whenever one of `changes` notifies (the
 * access in force: a `perm.changed` follows every change of grants, states and policies). A change
 * of the regions that raises no new access (a region marked by this user, for example) is seen at
 * the next reading only.
 */
import type { PermissionsPort } from '@docedit/protocol';
import type { GrantsService, GrantsSnapshot, RegionGrant, RegionSummary } from '@docedit/ui';
import type { ReadView } from './session.ts';

/** The derived region list of `GET /documents/{id}/regions`, as a view the shell can watch. */
export function regionsView(
  regions: NonNullable<PermissionsPort['regions']>,
  docId: string,
  changes: ReadonlyArray<ReadView<unknown>>,
): ReadView<readonly RegionSummary[]> {
  let value: readonly RegionSummary[] = [];
  let asked = 0;
  const listeners = new Set<() => void>();
  let stops: Array<() => void> = [];

  const read = (): void => {
    const mine = ++asked;
    regions(docId).then(
      (list) => {
        // A slower, older answer never replaces a newer one.
        if (mine !== asked) return;
        value = list;
        for (const listener of [...listeners]) listener();
      },
      // A failed read keeps the last list; the pane shows what it had.
      () => {},
    );
  };

  return {
    get: () => value,
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        stops = changes.map((c) => c.subscribe(read));
        read();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        for (const stop of stops) stop();
        stops = [];
      };
    },
  };
}

/** `GET` and `PATCH /documents/{id}/grants` as the shell's grants service (If-Match on save). */
export function grantsService(
  port: {
    grants: NonNullable<PermissionsPort['grants']>;
    updateGrants: NonNullable<PermissionsPort['updateGrants']>;
  },
  docId: string,
): GrantsService {
  const snapshot = (tagged: {
    value: { grants: readonly RegionGrant[] };
    etag: string;
  }): GrantsSnapshot => ({ etag: tagged.etag, grants: tagged.value.grants });
  return {
    load: async () => snapshot(await port.grants(docId)),
    save: async (grants, etag) =>
      snapshot(
        await port.updateGrants(
          docId,
          { grants: grants.map((g) => ({ ...g })) },
          { ifMatch: etag },
        ),
      ),
  };
}
