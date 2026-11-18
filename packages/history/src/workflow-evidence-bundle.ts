/**
 * The evidence bundle of a workflow and its verification (12 §8.2 step 4, §10; FRW-055 criteria 1
 * and 3). Pure and universal: a third party runs `verifyWorkflowEvidenceBundle` on the JSON alone.
 *
 * The bundle holds:
 *
 * - `log`: the records of the document's log from `from` to `to` (the workflow's `sentSeq` to the
 *   head), each with its metadata and its three hashes. Only the control commits carry their payload
 *   (`{ steps: [], retired, claimed }`, no document text); every other record is held without it, so
 *   the bundle holds no content. The chain is checked from the stored hashes, and each control
 *   payload is checked against its stored hash.
 * - `evidence`: the evidence items with their salts, canonical texts and commitments
 *   (`@docedit/authority`, `buildBundle`).
 * - `instructions`: what the bundle proves and what it does not (FRW-058 wording).
 *
 * A finding names what failed: a record by its `seq`, an evidence item by its identifier. The PDF's
 * signature and time-stamp, and the match of the evidence hashes with the chain, are not checked
 * here (FRW-053 and the signing service).
 */
import {
  BUNDLE_INSTRUCTIONS,
  verifyBundle as verifyEvidenceItems,
  type EvidenceBundleFile,
} from '@docedit/authority';
import {
  BUNDLE_FORMAT,
  verifyBundle as verifyLog,
  type Anchor,
  type BundleCommit,
  type VerifyOptions,
  type VerifyReport,
} from './chain.ts';

export const WORKFLOW_BUNDLE_FORMAT = 'docedit-workflow-evidence/1';

export interface WorkflowEvidenceBundle {
  format: typeof WORKFLOW_BUNDLE_FORMAT;
  doc: string;
  workflow: string;
  log: {
    /** The first `seq` held. */
    from: number;
    /** The last `seq` held. */
    to: number;
    /** The head of the held records: `seq` equal to `to`, and that record's hash. */
    head: { seq: number; chainHead: string | null };
    commits: BundleCommit[];
    anchors?: Anchor[];
  };
  evidence: EvidenceBundleFile;
  instructions: readonly string[];
}

/** The steps a third party follows, written into every bundle. */
export const WORKFLOW_BUNDLE_INSTRUCTIONS: readonly string[] = [
  'Save this file and run: node packages/history/scripts/verify-log.ts <bundle.json> [--anchor <seq>:<hash>]... . It needs no access to the service. The report names each record by its `seq` and each evidence item by its identifier. Exit 0: intact. Exit 1: altered. Exit 2: incomplete.',
  'The log records are checked by recomputing the hash chain from the stored hashes, starting at `log.from`. Each control commit carries its payload, which is checked against its stored hash; other records are held without their payload.',
  ...BUNDLE_INSTRUCTIONS,
];

/** Whether a value is a workflow evidence bundle of the expected format. */
export function isWorkflowEvidenceBundle(value: unknown): value is WorkflowEvidenceBundle {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { format?: unknown }).format === WORKFLOW_BUNDLE_FORMAT
  );
}

export type FindingKind = 'format' | 'commit' | 'evidence';

export interface Finding {
  readonly kind: FindingKind;
  /** The `seq` of a record, the identifier of an evidence item, or the document for the format. */
  readonly ref: number | string;
  readonly reason: string;
}

export interface WorkflowBundleVerdict {
  /** True only when the log is intact and every evidence item verifies. */
  readonly ok: boolean;
  readonly log: VerifyReport;
  /** The identifiers of the evidence items that fail. */
  readonly failedEvidence: readonly string[];
  /** Every thing that failed, the first bad record and each bad item, named. */
  readonly findings: readonly Finding[];
}

function malformed(bundle: unknown): string | null {
  const b = bundle as Partial<WorkflowEvidenceBundle> | null;
  if (b === null || typeof b !== 'object' || b.format !== WORKFLOW_BUNDLE_FORMAT)
    return `not a bundle of format ${WORKFLOW_BUNDLE_FORMAT}`;
  if (typeof b.doc !== 'string' || typeof b.workflow !== 'string')
    return 'the bundle names no document or workflow';
  if (b.log === undefined || !Array.isArray(b.log.commits) || b.log.head === undefined)
    return 'the bundle holds no log segment';
  if (b.evidence === undefined || !Array.isArray(b.evidence.items))
    return 'the bundle holds no evidence record';
  return null;
}

/**
 * Verifies a workflow evidence bundle: the chain over the segment, the payload of each control
 * commit and every evidence commitment. A bundle with one record or one evidence item altered fails
 * and names it.
 */
export async function verifyWorkflowEvidenceBundle(
  bundle: WorkflowEvidenceBundle,
  options: Omit<VerifyOptions, 'firstSeq'> = {},
): Promise<WorkflowBundleVerdict> {
  const bad = malformed(bundle);
  if (bad !== null) {
    const log: VerifyReport = {
      status: 'incomplete',
      doc: '',
      head: 0,
      commits: 0,
      payloadsChecked: 0,
      payloadsAbsent: 0,
      problems: [{ check: 'format', reason: bad, altered: false }],
      checkpoints: [],
      anchors: [],
    };
    return {
      ok: false,
      log,
      failedEvidence: [],
      findings: [{ kind: 'format', ref: '', reason: bad }],
    };
  }
  const log = await verifyLog(
    {
      format: BUNDLE_FORMAT,
      doc: bundle.doc,
      head: bundle.log.head,
      commits: bundle.log.commits,
      anchors: bundle.log.anchors ?? [],
    },
    { ...options, firstSeq: bundle.log.from },
  );
  const evidence = await verifyEvidenceItems(bundle.evidence);
  const findings: Finding[] = [];
  for (const p of log.problems)
    findings.push({
      kind: p.check === 'format' ? 'format' : 'commit',
      ref: p.seq ?? bundle.doc,
      reason: p.reason,
    });
  for (const item of evidence.items)
    if (!item.ok)
      findings.push({ kind: 'evidence', ref: item.id, reason: item.problem ?? 'mismatch' });
  return {
    ok: log.status === 'intact' && evidence.ok,
    log,
    failedEvidence: evidence.failed,
    findings,
  };
}
