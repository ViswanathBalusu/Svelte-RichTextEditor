/**
 * Anchors the salted hash of one event's evidence in the commit log (12 §7; ADR 0013; FRW-041).
 *
 * The evidence stays in the evidence table of the workflow. The chain holds one control commit for it, which
 * carries the origin (`sign` for a signing, `rules` for a completion) and the salted hash, and
 * nothing else. The commit follows the signing or completion it proves, because the evidence of a
 * signing names that commit's `seq` and chain hash and so cannot be part of it.
 *
 * The request goes to the outbox with a commit identifier derived from the hash, so a repeat (a
 * retry after a stop, or a second call that finds the evidence already recorded) is one item and
 * one commit. The outbox is durable: the caller waits a short time to report the `seq`, and an
 * item the room has not stored by then stays pending and is delivered later. Nothing here refuses
 * for the state of the document.
 */
import { derivedCommitId } from '../data-plane/commit-id.ts';
import type { DocRef, OutboxStore } from '../storage/types.ts';

export interface AnchorDeps {
  readonly outbox: OutboxStore;
  readonly now: () => number;
  /** How long to wait for the room to store the commit, ms. */
  readonly waitMs?: number;
}

export interface Anchored {
  /** The `seq` of the control commit, or null when it is queued and not stored yet. */
  readonly seq: number | null;
}

export async function anchorEvidence(
  deps: AnchorDeps,
  ref: DocRef,
  evidence: { readonly origin: 'sign' | 'rules' | 'decline'; readonly evidenceHash: string },
): Promise<Anchored> {
  const item = await deps.outbox.enqueue({
    tenant: ref.tenant,
    doc: ref.doc,
    commitId: derivedCommitId('evidence', ref.tenant, ref.doc, evidence.evidenceHash),
    kind: 'author',
    request: {
      actor: 'system',
      evidence: { origin: evidence.origin, evidenceHash: evidence.evidenceHash },
    },
  });
  const deadline = deps.now() + (deps.waitMs ?? 2_000);
  let settled = item;
  while (settled.state === 'pending' && deps.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    settled = (await deps.outbox.get(ref.tenant, item.id)) ?? settled;
  }
  const seq = (settled.result as { seq?: unknown } | null)?.seq;
  return { seq: settled.state === 'done' && typeof seq === 'number' ? seq : null };
}
