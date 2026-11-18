/**
 * An erasure request against a legal hold (08 §11, §13; HIS-031 criterion 5; HIS-038).
 *
 * Owner decision 38 (docs/owner-decisions-2026-11-15.md): the hold wins. A request to erase a person
 * who appears in a document under hold is not run. It is recorded as pending, and it runs when the
 * hold is released. The request and the delay are audited. This module holds the rule and the audit
 * records; the service stores the pending requests and deletes the mapping row.
 *
 * The person is named by the surrogate identifier, never by the host `sub`, so no record here can
 * lead back to a person once the mapping row is gone.
 */

export interface ErasureRequest {
  /** The surrogate identifier of the person (not the host `sub`). */
  person: string;
  /** The service credential or administrator that made the request. */
  requestedBy: string;
  /** Server time, Unix milliseconds. */
  requestedAt: number;
}

/** A request that waits for a hold to be released. */
export interface PendingErasure extends ErasureRequest {
  /** The documents under hold in which the person appears, sorted, without repeats. */
  blockedBy: readonly string[];
}

export type ErasureAudit =
  | {
      kind: 'erasure-deferred';
      person: string;
      requestedBy: string;
      requestedAt: number;
      blockedBy: readonly string[];
    }
  | {
      kind: 'erasure-run';
      person: string;
      requestedBy: string;
      requestedAt: number;
      /** When the erasure ran. */
      at: number;
      /** `at - requestedAt`: zero for a request that was not held back. */
      delayMs: number;
    };

export type ErasureDecision =
  | { action: 'erase'; audit: ErasureAudit }
  | { action: 'defer'; pending: PendingErasure; audit: ErasureAudit };

function sortedUnique(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort();
}

/**
 * Decides one request. `appearsIn` is the documents in which the person has written; `held` is the
 * documents under a legal hold. A request that touches no held document runs at once; any other
 * is deferred, with the held documents that block it.
 */
export function decideErasure(
  request: ErasureRequest,
  appearsIn: Iterable<string>,
  held: ReadonlySet<string>,
): ErasureDecision {
  const blockedBy = sortedUnique([...appearsIn].filter((d) => held.has(d)));
  if (blockedBy.length === 0)
    return {
      action: 'erase',
      audit: {
        kind: 'erasure-run',
        person: request.person,
        requestedBy: request.requestedBy,
        requestedAt: request.requestedAt,
        at: request.requestedAt,
        delayMs: 0,
      },
    };
  return {
    action: 'defer',
    pending: { ...request, blockedBy },
    audit: {
      kind: 'erasure-deferred',
      person: request.person,
      requestedBy: request.requestedBy,
      requestedAt: request.requestedAt,
      blockedBy,
    },
  };
}

export interface DeferredRun {
  /** The requests that are now free, oldest first, each with its audit record (the delay). */
  run: { pending: PendingErasure; audit: ErasureAudit }[];
  /** The requests still blocked, with the documents that still block each. */
  waiting: PendingErasure[];
}

/**
 * Re-checks the pending requests after a hold is released. A request runs only when none of the
 * documents that blocked it is still under hold.
 */
export function releaseDeferred(
  pending: readonly PendingErasure[],
  held: ReadonlySet<string>,
  now: number,
): DeferredRun {
  const out: DeferredRun = { run: [], waiting: [] };
  const ordered = [...pending].sort(
    (a, b) =>
      a.requestedAt - b.requestedAt || (a.person < b.person ? -1 : a.person > b.person ? 1 : 0),
  );
  for (const p of ordered) {
    const blockedBy = p.blockedBy.filter((d) => held.has(d));
    if (blockedBy.length > 0) {
      out.waiting.push({ ...p, blockedBy });
      continue;
    }
    out.run.push({
      pending: p,
      audit: {
        kind: 'erasure-run',
        person: p.person,
        requestedBy: p.requestedBy,
        requestedAt: p.requestedAt,
        at: now,
        delayMs: Math.max(0, now - p.requestedAt),
      },
    });
  }
  return out;
}
