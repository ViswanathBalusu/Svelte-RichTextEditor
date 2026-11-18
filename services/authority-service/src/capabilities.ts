/**
 * What this authority service supports (05 §9, §10; PRO-101): the calls it implements, and the
 * features a sidecar-backed backend may therefore announce. A sidecar reads this at start-up (or
 * from `GET /v1/authority/capabilities`) and announces no more than `features`.
 *
 * `IMPLEMENTED_CALLS` grows as the calls of 05 §10 are built: `open` and `materialise` are PRO-103,
 * `migrate` and `evaluateRules` are PRO-107. `applyCommit`, `mapRanges`, `restoreSteps`, `diff` and
 * `attribution` (PRO-104 to PRO-106) are not here, so the features that need them are not offered.
 */
import {
  type AuthorityServiceCall,
  featuresSupportedBy,
  tierProblems,
  type TierProblem,
} from '@docedit/protocol/client';

export const IMPLEMENTED_CALLS: readonly AuthorityServiceCall[] = ['open', 'materialise'];

export interface Capabilities {
  /** The calls of 05 §10 this service implements. */
  calls: readonly AuthorityServiceCall[];
  /** The features a backend that delegates to this service may announce. */
  features: string[];
}

export function capabilities(
  calls: readonly AuthorityServiceCall[] = IMPLEMENTED_CALLS,
): Capabilities {
  return { calls: [...calls], features: featuresSupportedBy(calls) };
}

/** What a sidecar-backed backend announces that this service does not support. */
export function sidecarProblems(
  announced: readonly string[],
  calls: readonly AuthorityServiceCall[] = IMPLEMENTED_CALLS,
): TierProblem[] {
  return tierProblems({
    tier: 'sidecar',
    discovery: { features: [...announced] as never },
    authorityServiceCalls: calls,
  });
}
