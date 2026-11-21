/**
 * The shell's check-out service over the backend's leases port (PRM-043; 05 §8.3). The shell offers
 * its check-out control only when the core has this service, and the element gives it one only when
 * the backend announces `leases` and has the port (`leasesFor`), so a server without the feature
 * shows no check-out.
 *
 * The port keeps a lease alive with heartbeats until it is released (07 §10; `backend-dep`). This
 * module keeps the list of the leases this session took, so the shell can tell its own lease from
 * another user's. The server stays the authority: the region list (`leasedTo`) says who holds a
 * region now, and the shell compares the two.
 */
import type { LeasesPort } from '@docedit/protocol';
import type { HeldLease, LeasesService } from '@docedit/ui';
import type { ReadView } from './session.ts';

/** What the element needs of a backend to offer check-out. */
export interface LeaseSource {
  readonly leases?: LeasesPort | undefined;
  readonly features: ReadonlySet<string>;
}

/**
 * The leases service of a session, or null when the backend does not announce `leases` or has no
 * port for them (05 §8.3: the interface shows a feature only when its port is present).
 */
export function leasesFor(
  backend: LeaseSource | null | undefined,
  docId: string,
): LeasesService | null {
  if (!backend?.leases || !backend.features.has('leases')) return null;
  return leasesService(backend.leases, docId);
}

export function leasesService(port: LeasesPort, docId: string): LeasesService {
  let held: readonly HeldLease[] = [];
  const listeners = new Set<() => void>();
  const set = (next: readonly HeldLease[]): void => {
    held = next;
    for (const listener of [...listeners]) listener();
  };
  const held$: ReadView<readonly HeldLease[]> = {
    get: () => held,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  return {
    held: held$,
    async acquire(region) {
      const tagged = await port.acquire(docId, region);
      const lease: HeldLease = {
        region,
        holder: tagged.value.holder,
        expiresAt: tagged.value.expiresAt,
      };
      set([...held.filter((l) => l.region !== region), lease]);
      return lease;
    },
    async release(region) {
      await port.release(docId, region);
      set(held.filter((l) => l.region !== region));
    },
  };
}
