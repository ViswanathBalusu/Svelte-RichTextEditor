/**
 * Erasing one workflow participant's evidence and field values (FRW-043 criterion 3 and the erasure
 * half of criterion 4; 12 §7, §14; ADR 0011 consequences; 08 §11, §13; owner decision 38 in
 * docs/owner-decisions-2026-11-15.md).
 *
 * For one participant of one document, and only when no legal hold is in force, `eraseParticipant`
 *
 * 1. replaces the payload of each commit that person wrote form field values in with a tombstone
 *    (`CommitTombstone`, HIS-040), so the metadata, the payload hash and the hash chain stay and the
 *    log still verifies;
 * 2. deletes the participant's evidence rows from `workflow_evidence`; and
 * 3. writes one audit entry, `evidence.erased`, which holds counts only: no participant identifier,
 *    no surrogate, no sequence number and no field value.
 *
 * A document under a hold is refused with `conflict` and nothing is changed. The deferral of owner
 * decision 38 (the erasure runs when the hold is released) is the person-level machinery of
 * `ErasureRequests`; this operation does not queue anything, so the caller asks again after the
 * release.
 *
 * Every commit to tombstone must lie under a checkpoint, as `CommitTombstone` requires (a room
 * loads from the newest checkpoint). The check is made for all of them first, so a refusal leaves
 * the log, the evidence and the audit trail as they were.
 *
 * What the tombstone does not reach (HIS-040 criterion 4, decision 84): checkpoints at or after the
 * commit and the attribution map may still hold the text. The result names the checkpoints that
 * hold copies; rewriting them is not built.
 *
 * Which commits are the participant's: those the person's surrogate authored whose scopes include a
 * form field (`field:<id>`, 12 §4.1) and whose payload is still present. The surrogate is looked up
 * from the participant by the caller (`surrogateOf`); the evidence rows are named by the workflow's
 * participant identifier.
 */
import { uuid7 } from '@docedit/model';
import { ApiError } from '../control-plane/problems.ts';
import type { AuditStore, CheckpointIndex, DocRef } from '../storage/types.ts';

/** The reason written on each tombstone. It names no person. */
export const PARTICIPANT_ERASURE_REASON = 'Erasure of a workflow participant';

/** The evidence rows of a participant, as the erasure reads and deletes them. */
export interface ParticipantEvidenceStore {
  /** Deletes every evidence row of the participant in the document and returns how many. */
  deleteParticipant(tenant: string, doc: string, participant: string): Promise<number>;
}

/** The commits that hold a participant's field values. */
export interface ParticipantCommits {
  /**
   * The `seq` of each commit of the document whose author is `surrogate`, whose scopes include a
   * form field and whose payload is still present, in order.
   */
  fieldCommits(tenant: string, doc: string, surrogate: string): Promise<readonly number[]>;
}

export interface ParticipantErasureDeps {
  evidence: ParticipantEvidenceStore;
  commits: ParticipantCommits;
  checkpoints: Pick<CheckpointIndex, 'list'>;
  /** `CommitTombstone.tombstone`, or a stand-in with its answer. */
  tombstone: (
    tenant: string,
    doc: string,
    seq: number,
    actor: string,
    reason: string,
  ) => Promise<{ copies: { checkpoints: readonly number[] } }>;
  audit: AuditStore;
  /** Whether a legal hold is in force on the document. */
  held: (tenant: string, doc: string) => Promise<boolean>;
  /** The surrogate that authors the commits of the participant, or null when none is known. */
  surrogateOf: (tenant: string, doc: string, participant: string) => Promise<string | null>;
  now: () => number;
}

export interface ParticipantErasureResult {
  /** How many evidence rows were deleted. */
  evidenceRows: number;
  /** How many commit payloads were replaced by tombstones. */
  tombstones: number;
  /** The checkpoints that may still hold the removed text, in order, without repeats. */
  checkpointCopies: readonly number[];
}

export async function eraseParticipant(
  deps: ParticipantErasureDeps,
  req: { ref: DocRef; participant: string; actor: string },
): Promise<ParticipantErasureResult> {
  const { ref, participant, actor } = req;
  if (await deps.held(ref.tenant, ref.doc))
    throw new ApiError('conflict', 'a legal hold is in force on this document');
  const surrogate = await deps.surrogateOf(ref.tenant, ref.doc, participant);
  const seqs =
    surrogate === null ? [] : await deps.commits.fieldCommits(ref.tenant, ref.doc, surrogate);
  if (seqs.length > 0) {
    const covered = (await deps.checkpoints.list(ref)).map((c) => c.seq);
    const newest = covered.length === 0 ? 0 : Math.max(...covered);
    if (seqs.some((s) => s > newest))
      throw new ApiError(
        'conflict',
        'a commit with the participant’s values lies above the newest checkpoint, so a room would need its payload to load',
      );
  }
  const copies = new Set<number>();
  for (const seq of seqs) {
    const done = await deps.tombstone(ref.tenant, ref.doc, seq, actor, PARTICIPANT_ERASURE_REASON);
    for (const c of done.copies.checkpoints) copies.add(c);
  }
  const evidenceRows = await deps.evidence.deleteParticipant(ref.tenant, ref.doc, participant);
  await deps.audit.record([
    {
      id: uuid7(),
      tenant: ref.tenant,
      doc: ref.doc,
      actor,
      kind: 'evidence.erased',
      data: { removedCount: evidenceRows, tombstonedCount: seqs.length },
      at: deps.now(),
    },
  ]);
  return {
    evidenceRows,
    tombstones: seqs.length,
    checkpointCopies: [...copies].sort((a, b) => a - b),
  };
}
