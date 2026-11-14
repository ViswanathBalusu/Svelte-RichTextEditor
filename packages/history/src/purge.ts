/**
 * Purging a deleted document's history (08 §13; 05 §6.2 `DELETE /documents/{id}`; HIS-039): the
 * plan only. The purge job in the document service runs the plan and deletes the stores it names;
 * this module decides what is removed and what is kept, and whether the purge runs at all.
 *
 * The rules:
 *
 * - a purge runs only for a document that was soft-deleted, once its retention period has passed
 *   (`retentionMs`, supplied by the caller: the spec does not give the period, HIS-039 notes; open);
 * - a document under legal hold is not purged while the hold lasts (HIS-031, `hold.ts`);
 * - an asset that another document also references is kept; every other asset of the document is
 *   removed;
 * - the removal covers commits and their metadata, cold segments, checkpoints, exports and search
 *   entries (08 §13). Backups age out on the operator's schedule and are not in this plan.
 */
import type { HoldState } from './hold.ts';
import { type HistoryResult, refuse } from './types.ts';

export interface PurgeAsset {
  id: string;
  /** Another document, not being purged, also references the asset. */
  sharedWithOtherDocument: boolean;
}

export interface PurgeRequest {
  doc: string;
  /** Server time of the soft delete, Unix milliseconds; `null` when the document is not deleted. */
  deletedAt: number | null;
  /** The retention period between soft delete and purge, in milliseconds (caller's choice). */
  retentionMs: number;
  /** The time of the run, Unix milliseconds. */
  now: number;
  hold: HoldState;
  /** The assets the document references. */
  assets: readonly PurgeAsset[];
}

export type PurgeOutcome =
  | { run: false; reason: 'not-deleted' | 'retention-running' | 'legal-hold' }
  | {
      run: true;
      /** The stores the job deletes for this document. */
      remove: {
        commits: true;
        coldSegments: true;
        checkpoints: true;
        exports: true;
        searchEntries: true;
        /** Assets used by no other document, in the order given. */
        assets: string[];
      };
      /** Assets kept because another document references them. */
      keptAssets: string[];
      /** The record the job writes when it runs (08 §13: audited). */
      audit: { action: 'purge'; doc: string; at: number };
    };

export type PurgePlan = HistoryResult<{ outcome: PurgeOutcome }>;

/** The plan for one document's purge at `now`. Nothing is deleted here. */
export function purgePlan(req: PurgeRequest): PurgePlan {
  if (req.doc.trim() === '') return refuse('validation_failed', 'a purge names its document');
  if (!Number.isSafeInteger(req.retentionMs) || req.retentionMs < 0)
    return refuse(
      'validation_failed',
      'retentionMs is a whole number of milliseconds, not negative',
    );
  if (!Number.isSafeInteger(req.now)) return refuse('validation_failed', 'now is a whole time');
  if (req.deletedAt !== null && !Number.isSafeInteger(req.deletedAt))
    return refuse('validation_failed', 'deletedAt is a whole time or null');
  const ids = new Set<string>();
  for (const a of req.assets) {
    if (a.id.trim() === '') return refuse('validation_failed', 'an asset has an identifier');
    if (ids.has(a.id)) return refuse('validation_failed', `asset ${a.id} is listed twice`);
    ids.add(a.id);
  }

  if (req.deletedAt === null) return { ok: true, outcome: { run: false, reason: 'not-deleted' } };
  // A hold is checked before the retention: a held document is never purged, due or not.
  if (req.hold.inForce) return { ok: true, outcome: { run: false, reason: 'legal-hold' } };
  if (req.now - req.deletedAt < req.retentionMs)
    return { ok: true, outcome: { run: false, reason: 'retention-running' } };

  return {
    ok: true,
    outcome: {
      run: true,
      remove: {
        commits: true,
        coldSegments: true,
        checkpoints: true,
        exports: true,
        searchEntries: true,
        assets: req.assets.filter((a) => !a.sharedWithOtherDocument).map((a) => a.id),
      },
      keptAssets: req.assets.filter((a) => a.sharedWithOtherDocument).map((a) => a.id),
      audit: { action: 'purge', doc: req.doc, at: req.now },
    },
  };
}
