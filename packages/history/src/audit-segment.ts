/**
 * The audit export of a log segment for third-party verification (08 §12; 12 §8.2 step 4; HIS-037).
 *
 * A segment holds the metadata rows of a range of commits, their payload hashes and the chain heads
 * that cover the range, and nothing else: no payloads, no checkpoints. It is checked by the same
 * universal verifier as a whole log (`verifyBundle`), started at its first `seq`, so a relying party
 * runs it offline with no access to the service.
 *
 * What a segment proves: the records from `from` to `to` link to each other, and each record's
 * hash matches its metadata and its payload hash. What it cannot prove on its own: that the record
 * at `from − 1` is the one the link names. That link is covered only by a chain head that a host or an
 * anchor recorded (`anchors`), so a segment should be checked against one.
 *
 * The visibility gate (07 §8; HIS-024) cuts the range at `minVisibleSeq`: no record below the gate is
 * included, neither its metadata nor its payload hash. One value from below the gate does leave: the
 * first record held keeps its `prevHash`, which is the chain hash of the record at `from − 1`. The
 * first record's own hash is computed over it, so the segment cannot verify without it. That hash is
 * a SHA-256 value and reveals no metadata or text, but it is revealed; whether a link-only form should
 * replace it is for the owner (ADR 0145 §6). The scopes of a record that touches a hidden region are still
 * in its metadata, because the metadata is hashed; how to hide them is left open (see HIS-037's notes).
 */
import {
  BUNDLE_FORMAT,
  type Anchor,
  type BundleCommit,
  type LogBundle,
  type VerifyOptions,
  type VerifyReport,
  verifyBundle,
} from './chain.ts';
import { type HistoryResult, refuse } from './types.ts';

export const SEGMENT_FORMAT = 'docedit-audit-segment/1';

/** The verification steps a relying party follows, written into every segment (HIS-037 criterion 1). */
export const SEGMENT_INSTRUCTIONS =
  'Save this file and run: node packages/history/scripts/verify-log.ts <segment.json> ' +
  '[--anchor <seq>:<hash>]... . The tool recomputes the chain from the record at `from`, checks the ' +
  'anchors it is given, and exits 0 when the segment is intact, 1 when it is altered, 2 when it is ' +
  'incomplete. It needs no access to the service and reads no payloads.';

/** A commit as the segment holds it: the record without its payload. */
export type SegmentCommit = Omit<BundleCommit, 'payload'>;

export interface AuditSegment {
  format: typeof SEGMENT_FORMAT;
  doc: string;
  /** The first `seq` held (not below the caller's gate). */
  from: number;
  /** The last `seq` held: the requested end, or the head. */
  to: number;
  /** The head of the segment: `seq` equal to `to`, and that record's hash. */
  head: { seq: number; chainHead: string | null };
  commits: SegmentCommit[];
  anchors: Anchor[];
  instructions: string;
}

export interface SegmentRequest {
  /** The first `seq` asked for; defaults to 1. */
  fromSeq?: number;
  /** The last `seq` asked for; defaults to the head. */
  toSeq?: number;
  /**
   * The caller's gate (HIS-024): records below it are never included; only the chain hash of the
   * record just below it travels, as the first held record's `prevHash`. Defaults to 0.
   */
  minVisibleSeq?: number;
}

/**
 * Builds the audit segment for a range of a document's log. The bundle is the full exported log of
 * the document, read by the caller from its stores; this function only selects and strips.
 */
export function auditSegment(
  bundle: LogBundle,
  req: SegmentRequest = {},
): HistoryResult<{ segment: AuditSegment }> {
  if (!bundle || bundle.format !== BUNDLE_FORMAT || !Array.isArray(bundle.commits))
    return refuse('validation_failed', 'the log is not a bundle of the expected format');
  const head = bundle.head.seq;
  const fromSeq = req.fromSeq ?? 1;
  const toSeq = req.toSeq ?? head;
  const gate = req.minVisibleSeq ?? 0;
  if (!Number.isSafeInteger(fromSeq) || !Number.isSafeInteger(toSeq) || fromSeq < 1)
    return refuse('validation_failed', 'the range is not a range of sequence numbers');
  if (fromSeq > toSeq) return refuse('validation_failed', 'the range starts after it ends');
  if (toSeq > head) return refuse('not_found', 'the range ends above the head of the document');
  if (toSeq < gate) return refuse('forbidden', 'the range lies below what the caller may see');

  const bySeq = new Map<number, BundleCommit>();
  for (const c of bundle.commits) if (Number.isSafeInteger(c.meta?.seq)) bySeq.set(c.meta.seq, c);
  const from = Math.max(fromSeq, gate);
  const commits: SegmentCommit[] = [];
  for (let seq = from; seq <= toSeq; seq++) {
    const c = bySeq.get(seq);
    if (!c) return refuse('not_found', `record ${seq} is not in the log`);
    // The payload is left out; its hash stays, which is what the chain is computed from.
    commits.push({ meta: c.meta, payloadHash: c.payloadHash, prevHash: c.prevHash, hash: c.hash });
  }
  const last = bySeq.get(toSeq);
  if (!last) return refuse('not_found', `record ${toSeq} is not in the log`);
  return {
    ok: true,
    segment: {
      format: SEGMENT_FORMAT,
      doc: bundle.doc,
      from,
      to: toSeq,
      head: { seq: toSeq, chainHead: last.hash },
      commits,
      anchors: (bundle.anchors ?? []).filter((a) => a.seq >= from && a.seq <= toSeq),
      instructions: SEGMENT_INSTRUCTIONS,
    },
  };
}

/** Whether a value is an audit segment of the expected format. */
export function isAuditSegment(value: unknown): value is AuditSegment {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { format?: unknown }).format === SEGMENT_FORMAT &&
    Array.isArray((value as { commits?: unknown }).commits)
  );
}

/**
 * Verifies an audit segment alone (HIS-037 criterion 2): the same checks as a log bundle, started at
 * `from`, with the segment's own anchors plus any the caller supplies.
 */
export async function verifySegment(
  segment: AuditSegment,
  options: VerifyOptions = {},
): Promise<VerifyReport> {
  const bundle: LogBundle = {
    format: BUNDLE_FORMAT,
    doc: segment.doc,
    head: segment.head,
    commits: segment.commits as BundleCommit[],
    checkpoints: [],
    anchors: segment.anchors,
  };
  return verifyBundle(bundle, { ...options, firstSeq: segment.from });
}
