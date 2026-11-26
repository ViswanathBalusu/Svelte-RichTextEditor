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
  'Each signing, completion and decline in the evidence record must also be found in the chain: its commitment is the `evidenceHash` of a control commit of the segment. A view and a consent are not anchored. The report lists the items found (`evidenceInChain`) and names any that are not.',
  "To check the sealed PDF as well, run: node services/signing-service/scripts/verify-final.ts <bundle.json> <sealed.pdf> --root <root certificate>... [--anchor <anchor file>] [--pdftotext <command>] . It checks this bundle as above, every signature and time-stamp of the PDF against the roots you name (it trusts none of its own), with the anchor file that the signed and time-stamped chain head at completion is this bundle's chain at that `seq`, and that the chain head printed on the certificate pages of the PDF is the hash of this bundle's commit at the sequence number the certificate names (it reads the PDF's text with pdftotext, from poppler). It does not say who any person is.",
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
  /**
   * The evidence items found in the chain: their commitment is in the payload of a control commit of
   * the segment (FRW-055 criterion 2). Only the items of a signing, a completion and a decline are
   * anchored; a view and a consent are not.
   */
  readonly evidenceInChain: readonly string[];
  /**
   * Anchored items that could not be looked for, because a control commit of the segment has no
   * payload (erased). They are not failures.
   */
  readonly evidenceUnchecked: readonly string[];
  /** The seq of control commits that anchor evidence the bundle does not hold (an erased participant, or an item left out). */
  readonly unmatchedAnchors: readonly number[];
  /** Every thing that failed, the first bad record and each bad item, named. */
  readonly findings: readonly Finding[];
}

/** The items a control commit anchors: a signing, a completion and a decline (FRW-041). */
const ANCHORED_ITEMS: ReadonlySet<string> = new Set(['signed', 'completed', 'declined']);

function isAnchoredItem(canonical: string): boolean {
  try {
    const item = (JSON.parse(canonical) as { item?: unknown }).item;
    return typeof item === 'string' && ANCHORED_ITEMS.has(item);
  } catch {
    return false;
  }
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
      evidenceInChain: [],
      evidenceUnchecked: [],
      unmatchedAnchors: [],
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
  // The match of the evidence with the chain (FRW-055 criterion 2): each anchored item's commitment
  // is the `evidenceHash` of a control commit of the segment. The commit payloads are checked by the
  // log verifier above, so a commitment read from one is the one the chain holds.
  const inChain: string[] = [];
  const unchecked: string[] = [];
  const failedMatch: string[] = [];
  const anchoredAt = new Map<string, number>();
  let erased = 0;
  for (const c of bundle.log.commits) {
    if (c.meta.kind !== 'control') continue;
    if (c.payload === undefined || c.payload === null) {
      erased += 1;
      continue;
    }
    const hash = (c.payload as { evidence?: { evidenceHash?: unknown } }).evidence?.evidenceHash;
    if (typeof hash === 'string') anchoredAt.set(hash, c.meta.seq);
  }
  const held = new Set<string>();
  for (const item of bundle.evidence.items) {
    held.add(item.commitment);
    const verdict = evidence.items.find((v) => v.id === item.id);
    if (!verdict?.ok || !isAnchoredItem(item.canonical)) continue;
    if (anchoredAt.has(item.commitment)) inChain.push(item.id);
    else if (erased > 0) unchecked.push(item.id);
    else {
      failedMatch.push(item.id);
      findings.push({
        kind: 'evidence',
        ref: item.id,
        reason: 'no control commit of the segment holds this commitment',
      });
    }
  }
  const unmatchedAnchors = [...anchoredAt].filter(([h]) => !held.has(h)).map(([, seq]) => seq);
  return {
    ok: log.status === 'intact' && evidence.ok && failedMatch.length === 0,
    log,
    failedEvidence: [...evidence.failed, ...failedMatch],
    evidenceInChain: inChain,
    evidenceUnchecked: unchecked,
    unmatchedAnchors,
    findings,
  };
}
