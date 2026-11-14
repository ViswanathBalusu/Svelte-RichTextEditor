/**
 * The purge job for workflow evidence (SEC-044 criterion 5; 12 §7, §14; FRW-043). The job takes the
 * decision of `planPurge` and applies it to a store the caller provides: it deletes exactly the rows
 * the plan names as removable, and writes the plan's audit entry (counts and the instant, no row
 * identifiers) to a sink.
 *
 * The job is not scheduled and is wired into no service: the caller runs it. The store and the
 * audit sink are interfaces, so the job holds no storage of its own. The retention period and the
 * start of the retention clock are the caller's (FRW-084 is open), as they are for `planPurge`.
 *
 * Universal code: no Node.js or browser APIs (FND-004).
 */
import { planPurge, type EvidenceRow, type PurgeAudit } from './retention.ts';

/** The rows of one document's evidence, as the job reads and deletes them. */
export interface EvidenceRowStore {
  /** Every evidence row of the document, in a stable order. */
  listRows(documentId: string): Promise<readonly EvidenceRow[]>;
  /** Deletes the named rows. The job calls it only with ids the plan marked removable. */
  deleteRows(documentId: string, ids: readonly string[]): Promise<void>;
}

/** Receives the audit entry of each run. */
export interface PurgeAuditSink {
  record(documentId: string, audit: PurgeAudit): Promise<void>;
}

export interface PurgeJobInput {
  readonly documentId: string;
  readonly nowMs: number;
  /** The retention period in milliseconds (no default is decided, FRW-084). */
  readonly retentionMs: number;
  /** Whether the document is under a legal hold at this run. */
  readonly legalHold: boolean;
}

export interface PurgeJobResult {
  readonly removed: readonly string[];
  readonly kept: readonly string[];
  readonly audit: PurgeAudit;
}

/**
 * Runs one purge over one document. Rows are deleted before the audit entry is recorded, so an
 * entry never reports a removal that did not happen. With no removable rows, no delete is made.
 */
export async function runEvidencePurge(
  store: EvidenceRowStore,
  sink: PurgeAuditSink,
  input: PurgeJobInput,
): Promise<PurgeJobResult> {
  const rows = await store.listRows(input.documentId);
  const plan = planPurge({
    rows,
    nowMs: input.nowMs,
    retentionMs: input.retentionMs,
    legalHold: input.legalHold,
  });
  if (plan.remove.length > 0) await store.deleteRows(input.documentId, plan.remove);
  await sink.record(input.documentId, plan.audit);
  return { removed: plan.remove, kept: plan.keep, audit: plan.audit };
}
