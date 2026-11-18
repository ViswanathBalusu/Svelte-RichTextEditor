/**
 * The live-use quota gate of the node (BE-091), as the data plane sees it.
 *
 * It lives in its own leaf module, not in `session.ts`, because `seams.ts` names it and
 * `session.ts` imports from `seams.ts`: a type-only import in each direction is still a cycle for
 * the dependency checker. `session.ts` re-exports it, so existing importers are unchanged.
 */
import type { Admission } from '../control-plane/live-quotas.ts';

/**
 * A connection is admitted at `hello` and released when the session ends, a channel is admitted
 * against the open-documents quota at `ch.open` and released when it ends, and each commit is
 * admitted before it is submitted. The CPU a room spends on a commit is charged afterwards, and a
 * spent budget refuses the next commit. Absent, no quota applies. `LiveQuotas` in
 * control-plane/live-quotas.ts is the implementation.
 */
export interface LiveQuotaGate {
  admitConnection(tenant: string): Admission;
  releaseConnection(tenant: string): void;
  admitCommit(tenant: string): Admission;
  admitDocument(tenant: string, doc: string): Admission;
  closeDocument(tenant: string, doc: string): void;
  admitCpu(tenant: string): Admission;
  chargeCpu(tenant: string, ms: number): void;
  /** Reads the tenant's current values before a decision; never rejects. */
  prepare?(tenant: string): Promise<void>;
}
