/**
 * Replacing one commit's payload with a tombstone (08 §13, second bullet; HIS-040) and reading a
 * payload that may have been removed.
 *
 * The metadata row and the payload hash stay, and the chain is computed from the stored hashes
 * (`chain.ts`), so the log still verifies after the payload is removed. What the tombstone cannot
 * do is reach copies that hold the same text elsewhere: checkpoints at or after the commit's `seq`
 * were built by replaying it, and the attribution map names it. `tombstone` reports those copies;
 * it does not rewrite them, because the spec does not say how (HIS-040 notes, open).
 */
import type { BundleCommit, LogBundle } from './chain.ts';
import type { HoldState } from './hold.ts';
import { type HistoryResult, refuse } from './types.ts';

export interface TombstoneRequest {
  seq: number;
  actor: string;
  reason: string;
  /** Server time, Unix milliseconds. */
  now: number;
  /** The document's hold; a tombstone is refused while one is in force (HIS-031). */
  hold: HoldState;
}

export interface TombstoneAudit {
  action: 'tombstone';
  doc: string;
  seq: number;
  actor: string;
  reason: string;
  at: number;
}

export interface TombstoneCopies {
  /** Checkpoints whose content may still hold the removed text, in `seq` order. */
  checkpoints: number[];
  /** The attribution map may still name runs of the removed commit. */
  attributionMap: 'may-hold-runs';
  /** Fixed wording of what removing those copies involves. */
  involves: string;
}

export interface TombstoneResult {
  bundle: LogBundle;
  audit: TombstoneAudit;
  copies: TombstoneCopies;
}

const INVOLVES =
  'rebuild or remove each listed checkpoint without the commit, and rewrite the attribution runs that name it';

function isPresent(c: BundleCommit): boolean {
  return c.payload !== undefined && c.payload !== null;
}

/** Replaces the payload of commit `seq` with a tombstone, without changing the input bundle. */
export function tombstone(
  bundle: LogBundle,
  req: TombstoneRequest,
): HistoryResult<TombstoneResult> {
  if (!Number.isSafeInteger(req.seq) || req.seq < 1)
    return refuse('validation_failed', 'seq names a commit');
  if (req.actor.trim() === '') return refuse('validation_failed', 'a tombstone names its actor');
  if (req.reason.trim() === '') return refuse('validation_failed', 'a tombstone names its reason');
  if (!Number.isSafeInteger(req.now)) return refuse('validation_failed', 'now is a whole time');
  if (req.hold.inForce) return refuse('conflict', 'a legal hold is in force on this document');
  const target = bundle.commits.find((c) => c.meta.seq === req.seq);
  if (!target) return refuse('not_found', 'no commit has that seq');
  if (!isPresent(target))
    return refuse('conflict', 'the payload of that commit is already removed');

  const commits = bundle.commits.map((c): BundleCommit => {
    if (c.meta.seq !== req.seq) return c;
    // The stored hashes stay; only the payload is dropped (chain.ts: thinned and tombstoned alike).
    return { meta: c.meta, payloadHash: c.payloadHash, prevHash: c.prevHash, hash: c.hash };
  });
  const checkpoints = (bundle.checkpoints ?? [])
    .filter((k) => k.seq >= req.seq)
    .map((k) => k.seq)
    .sort((a, b) => a - b);
  return {
    ok: true,
    bundle: { ...bundle, commits },
    audit: {
      action: 'tombstone',
      doc: bundle.doc,
      seq: req.seq,
      actor: req.actor,
      reason: req.reason,
      at: req.now,
    },
    copies: { checkpoints, attributionMap: 'may-hold-runs', involves: INVOLVES },
  };
}

/**
 * The payload of commit `seq`, when the log holds it. A commit whose payload was thinned, moved or
 * tombstoned is refused with a fixed reason, never with a guess (HIS-040 criterion 2).
 */
export function payloadOf(bundle: LogBundle, seq: number): HistoryResult<{ payload: unknown }> {
  const c = bundle.commits.find((x) => x.meta.seq === seq);
  if (!c) return refuse('not_found', 'no commit has that seq');
  if (!isPresent(c))
    return refuse('not_found', 'the detail of that commit was removed and is not in this log');
  return { ok: true, payload: c.payload };
}
