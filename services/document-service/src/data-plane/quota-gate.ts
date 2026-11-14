/**
 * The live-use quota gate of the node (BE-091), as the data plane sees it.
 *
 * It lives in its own leaf module, not in `session.ts`, because `seams.ts` names it and
 * `session.ts` imports from `seams.ts`: a type-only import in each direction is still a cycle for
 * the dependency checker. `session.ts` re-exports it, so existing importers are unchanged.
 */
import type { Admission } from '../control-plane/live-quotas.ts';

/**
 * A connection is admitted at `hello` and released when the session ends, and each commit is
 * admitted before it is submitted. Absent, no quota applies. `LiveQuotas` in
 * control-plane/live-quotas.ts is the implementation.
 */
export interface LiveQuotaGate {
  admitConnection(tenant: string): Admission;
  releaseConnection(tenant: string): void;
  admitCommit(tenant: string): Admission;
}
