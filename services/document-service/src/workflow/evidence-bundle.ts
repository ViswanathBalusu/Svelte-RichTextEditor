/**
 * The evidence bundle of a workflow (12 §8.2 step 4, §10; FRW-055 criterion 1): the log segment from
 * the workflow's `sentSeq` to the head, the control commits with their payload, the evidence record
 * and the instructions. `@docedit/history` verifies it (`verifyWorkflowEvidenceBundle`).
 *
 * The chain is recomputed from the stored commits with the codec that wrote them
 * (`storage/codec.ts`), starting at the first commit of the log so that the first held record
 * carries the true previous hash. Only a control commit carries its payload, which holds no steps
 * and so no document text; every other record is held without it. A commit whose payload was
 * tombstoned or thinned cannot be recomputed here: the PostgreSQL store reports such a commit
 * without its steps and the recomputed hash then differs from the stored one, which verification
 * would name. Reading the stored hashes instead is not offered by `LogStore` and is left to the
 * history service (HIS-033).
 */
import { buildBundle, type BundleItem } from '@docedit/authority';
import {
  WORKFLOW_BUNDLE_FORMAT,
  WORKFLOW_BUNDLE_INSTRUCTIONS,
  type BundleCommit,
  type WorkflowEvidenceBundle,
} from '@docedit/history';
import type { DocRef, LogStore } from '../storage/types.ts';
import { chainHash, encodeCommit } from '../storage/codec.ts';
import { evidenceCanonical, toHex, type EvidenceLedger } from './evidence-ledger.ts';
import type { WorkflowResourceView } from './workflow-resource.ts';

export type EvidenceBundleOutcome =
  | { readonly ok: true; readonly bundle: WorkflowEvidenceBundle }
  | { readonly ok: false; readonly reason: 'not_sent' | 'empty_log' };

export async function buildWorkflowEvidenceBundle(
  deps: { readonly logs: LogStore; readonly evidence: EvidenceLedger },
  ref: DocRef,
  workflow: WorkflowResourceView,
): Promise<EvidenceBundleOutcome> {
  if (workflow.sentSeq === null || workflow.sentSeq === undefined)
    return { ok: false, reason: 'not_sent' };
  // `sentSeq` is the head at the send: 0 for a document with no commit, and the log starts at 1.
  const from = Math.max(1, workflow.sentSeq);
  const stored = await deps.logs.read(ref);
  if (stored.length === 0) return { ok: false, reason: 'empty_log' };

  const commits: BundleCommit[] = [];
  let prev: Buffer | null = null;
  for (const c of stored) {
    const enc = encodeCommit(ref.doc, c);
    const hash = chainHash(prev, enc.metaBytes, enc.payloadHash);
    if (c.seq >= from)
      commits.push({
        meta: enc.meta,
        payloadHash: enc.payloadHash.toString('hex'),
        prevHash: prev === null ? null : prev.toString('hex'),
        hash: hash.toString('hex'),
        ...(c.kind === 'control'
          ? {
              payload: {
                steps: c.steps,
                retired: c.retired,
                claimed: c.claimed,
                // The salted hash an evidence anchor carries, the origin and nothing else.
                ...(c.evidence !== undefined
                  ? {
                      evidence: {
                        origin: c.evidence.origin,
                        evidenceHash: c.evidence.evidenceHash,
                      },
                    }
                  : {}),
              },
            }
          : {}),
      });
    prev = hash;
  }
  const last = stored[stored.length - 1]!;
  const items: BundleItem[] = [];
  for (const row of await deps.evidence.list(ref.tenant, ref.doc))
    items.push({
      id: row.id,
      saltHex: toHex(row.salt),
      canonical: evidenceCanonical(row.participant, row.item, row.evidence),
      commitment: row.hash,
    });
  return {
    ok: true,
    bundle: {
      format: WORKFLOW_BUNDLE_FORMAT,
      doc: ref.doc,
      workflow: workflow.id,
      log: {
        from,
        to: last.seq,
        head: { seq: last.seq, chainHead: prev === null ? null : prev.toString('hex') },
        commits,
      },
      evidence: buildBundle(items),
      instructions: WORKFLOW_BUNDLE_INSTRUCTIONS,
    },
  };
}
