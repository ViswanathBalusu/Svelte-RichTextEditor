/**
 * The check a relying party makes of a head against the public log (SEC-067; ADR 0409 decision 7;
 * 08 §12). It needs no network and no access to the service: the evidence carries the receipt, and
 * the log's public key is given by the relying party, not read from the receipt.
 *
 * The results, each reported on its own:
 *
 * - `entry`: the public entry is in its canonical form.
 * - `proof`: the head, with the salt and the path, leads to the entry's root.
 * - `receipt`: the log's checkpoint is signed by the log's key, names the receipt's log and size, the
 *   leaf is the hash of the entry, and the inclusion proof leads to the checkpoint's root.
 * - `chain`: the log (a bundle or an audit segment) verifies, and its hash at the anchored `seq` is
 *   the anchored head.
 *
 * A chain rewritten after its root was published has another hash at that `seq`. The report then
 * says that the head of the log at that `seq` is not in the published root, and shows it by folding
 * the rewritten head along the same path. A head committed after the last published root is not
 * covered: if the log reaches past the anchored `seq`, the report says "not yet anchored" with the
 * end of the period of the newest root, and it is not a failure. A root that has no receipt yet is
 * "incomplete", not a failure.
 */
import {
  parsePublicEntry,
  verifyBundle,
  verifyPublicRootProof,
  verifySegment,
  type AuditSegment,
  type LogBundle,
  type PublicAnchorEvidence,
  type VerifyReport,
} from '@docedit/history';
import { checkReceipt, type ReceiptCheck } from './log-port.ts';
import type { LogVerifier } from './tlog.ts';

export type PublicAnchorStatus = 'verified' | 'failed' | 'incomplete' | 'not-yet-anchored';

export interface PublicAnchorReport {
  status: PublicAnchorStatus;
  doc: string;
  head: { seq: number; chainHead: string };
  entry: { ok: boolean; root?: string; periodEnd?: string; leaves?: number };
  proof: { covered: boolean };
  receipt:
    | { state: 'missing' }
    | { state: 'unchecked'; reason: string }
    | { state: 'checked'; logId: string; index: number; check: ReceiptCheck };
  chain: {
    state: 'not-given' | 'verified' | 'altered' | 'incomplete';
    log?: { status: string; head: number; commits: number; firstBadSeq?: number };
    /** The log's hash at the anchored `seq`: the anchored head, or another. */
    anchoredHead: 'match' | 'mismatch' | 'unreached' | 'not-compared';
  };
  /** Set when the log reaches past the anchored `seq`: what is covered and until when. */
  notYetAnchored: { afterSeq: number; logHead: number; periodEnd: string } | null;
  problems: string[];
}

export interface VerifyPublicAnchorOptions {
  /** The log's public key. Without it a receipt cannot be checked. */
  logKey?: LogVerifier | undefined;
  /** The document's log: a bundle (`docedit-log-bundle/1`) or an audit segment. */
  chain?: LogBundle | AuditSegment | undefined;
}

const isSegment = (c: LogBundle | AuditSegment): c is AuditSegment =>
  (c as AuditSegment).format === 'docedit-audit-segment/1';

/** Checks one piece of evidence. It never rejects for what is wrong with the evidence: it reports. */
export async function verifyPublicAnchor(
  evidence: PublicAnchorEvidence,
  options: VerifyPublicAnchorOptions = {},
): Promise<PublicAnchorReport> {
  const problems: string[] = [];
  const report: PublicAnchorReport = {
    status: 'incomplete',
    doc: evidence.doc,
    head: { seq: evidence.head.seq, chainHead: evidence.head.chainHead },
    entry: { ok: false },
    proof: { covered: false },
    receipt: { state: 'missing' },
    chain: { state: 'not-given', anchoredHead: 'not-compared' },
    notYetAnchored: null,
    problems,
  };

  // The entry.
  const entry = parsePublicEntry(evidence.entry);
  if (!entry.ok) {
    problems.push(`the public entry is not valid: ${entry.reason}`);
    report.status = 'failed';
    return report;
  }
  report.entry = {
    ok: true,
    root: entry.entry.root,
    periodEnd: entry.entry.to,
    leaves: entry.entry.leaves,
  };

  // The head, the salt and the path against the root.
  const salt = Uint8Array.from(Buffer.from(evidence.salt, 'hex'));
  const proof = await verifyPublicRootProof(entry.entry.root, {
    salt,
    head: evidence.head,
    path: evidence.path,
  });
  report.proof.covered = proof.ok && proof.covered;
  if (!proof.ok) problems.push(`the proof cannot be read: ${proof.reason}`);
  else if (!proof.covered) problems.push('the head is not in the published root');

  // The receipt.
  if (evidence.receipt === null) report.receipt = { state: 'missing' };
  else if (options.logKey === undefined)
    report.receipt = { state: 'unchecked', reason: 'no public key of the log was given' };
  else {
    const check = checkReceipt(
      new TextEncoder().encode(evidence.entry),
      evidence.receipt,
      options.logKey,
    );
    report.receipt = {
      state: 'checked',
      logId: evidence.receipt.logId,
      index: evidence.receipt.index,
      check,
    };
    if (!check.signature) problems.push("the checkpoint is not signed by the log's key");
    else if (!check.checkpoint) problems.push('the checkpoint does not name the receipt');
    if (!check.leaf) problems.push('the receipt is not for this entry');
    if (check.signature && !check.inclusion)
      problems.push('the inclusion proof does not lead to the checkpoint');
  }

  // The chain up to the head.
  if (options.chain !== undefined) {
    const anchor = { seq: evidence.head.seq, hash: evidence.head.chainHead, source: 'public root' };
    const chain = options.chain;
    if (chain.doc !== evidence.doc) {
      problems.push('the log is of another document');
      report.chain = { state: 'incomplete', anchoredHead: 'unreached' };
    } else {
      const verdict: VerifyReport = isSegment(chain)
        ? await verifySegment(chain, { anchors: [anchor] })
        : await verifyBundle({ ...chain, checkpoints: [] }, { anchors: [anchor] });
      const found = verdict.anchors.find((a) => a.source === 'public root');
      const anchoredHead =
        found?.result === 'match'
          ? 'match'
          : found?.result === 'mismatch'
            ? 'mismatch'
            : 'unreached';
      // A head that differs from the anchored one makes the verifier call the log altered. That is
      // reported below as a head that is not in the root; the chain itself may be consistent.
      const ownProblems = verdict.problems.filter((p) => p.check !== 'anchor');
      const chainState =
        verdict.status === 'incomplete'
          ? 'incomplete'
          : ownProblems.length > 0
            ? 'altered'
            : 'verified';
      report.chain = {
        state: chainState,
        log: {
          status: verdict.status,
          head: verdict.head,
          commits: verdict.commits,
          ...(verdict.firstBadSeq !== undefined ? { firstBadSeq: verdict.firstBadSeq } : {}),
        },
        anchoredHead,
      };
      if (chainState === 'altered') problems.push('the log does not verify');
      if (anchoredHead === 'mismatch') {
        // The log was rewritten after the root was published, or the evidence is for another log.
        // Fold the log's own head at that seq along the same path: it is not in the root.
        const own = (chain.commits as ReadonlyArray<{ meta: { seq: number }; hash: string }>).find(
          (c) => c.meta.seq === evidence.head.seq,
        )?.hash;
        const folded =
          own === undefined
            ? null
            : await verifyPublicRootProof(entry.entry.root, {
                salt,
                head: { seq: evidence.head.seq, chainHead: own },
                path: evidence.path,
              });
        problems.push(
          folded !== null && folded.ok && !folded.covered
            ? `the head of the log at seq ${evidence.head.seq} is not in the published root`
            : 'the anchored head is not the hash of the log at that seq',
        );
      }
      if (anchoredHead === 'match' && verdict.head > evidence.head.seq)
        report.notYetAnchored = {
          afterSeq: evidence.head.seq,
          logHead: verdict.head,
          periodEnd: entry.entry.to,
        };
    }
  }
  const failed = problems.length > 0;
  const compared = report.chain.anchoredHead === 'match' && report.chain.state === 'verified';
  const receiptOk = report.receipt.state === 'checked' && report.receipt.check.ok;
  report.status = failed
    ? 'failed'
    : report.notYetAnchored !== null && receiptOk
      ? 'not-yet-anchored'
      : compared && receiptOk && report.proof.covered
        ? 'verified'
        : 'incomplete';
  return report;
}

/** The process exit code of a status: 0 verified, 1 failed, 2 incomplete, 4 not yet anchored. */
export const PUBLIC_ANCHOR_EXIT: Readonly<Record<PublicAnchorStatus, number>> = {
  verified: 0,
  failed: 1,
  incomplete: 2,
  'not-yet-anchored': 4,
};
