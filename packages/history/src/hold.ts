/**
 * Legal holds on a document's history (08 §11; 13 §10; HIS-031).
 *
 * A hold freezes deletion while a dispute lasts. This module holds the state transitions and the
 * audit record of each one; the thinning plan (`thinning.ts`) and the tombstone (`tombstone.ts`)
 * read the state and refuse or suspend while it is in force. Who may set or release a hold is the
 * caller's decision (a service credential or the administration API); this module only checks that
 * the change names an actor, a reason and a time, and that it changes the state.
 */
import { type HistoryResult, refuse } from './types.ts';

export interface HoldState {
  inForce: boolean;
}

export const NO_HOLD: HoldState = { inForce: false };

export interface HoldChange {
  action: 'set' | 'release';
  /** The person or service credential that makes the change. */
  actor: string;
  /** Why it is made, in a short phrase. */
  reason: string;
  /** Server time, Unix milliseconds. */
  now: number;
}

export interface HoldAudit {
  action: 'hold-set' | 'hold-released';
  actor: string;
  reason: string;
  at: number;
}

export function applyHold(
  state: HoldState,
  change: HoldChange,
): HistoryResult<{ state: HoldState; audit: HoldAudit }> {
  if (change.actor.trim() === '') return refuse('validation_failed', 'a hold names its actor');
  if (change.reason.trim() === '') return refuse('validation_failed', 'a hold names its reason');
  if (!Number.isSafeInteger(change.now)) return refuse('validation_failed', 'now is a whole time');
  if (change.action === 'set') {
    if (state.inForce) return refuse('conflict', 'a legal hold is already in force');
    return {
      ok: true,
      state: { inForce: true },
      audit: { action: 'hold-set', actor: change.actor, reason: change.reason, at: change.now },
    };
  }
  if (!state.inForce) return refuse('conflict', 'no legal hold is in force');
  return {
    ok: true,
    state: { inForce: false },
    audit: { action: 'hold-released', actor: change.actor, reason: change.reason, at: change.now },
  };
}
