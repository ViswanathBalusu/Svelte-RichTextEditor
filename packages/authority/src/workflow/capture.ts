/**
 * The tenant setting that switches off IP address and user agent capture in workflow evidence
 * (12 §7, last sentence; FRW-042), as pure functions.
 *
 * - `captureEvidence` builds the evidence of one event. With the setting off, no IP address and no
 *   user agent is kept, whatever the caller passes; the other items are kept as given. Keys named
 *   `ipAddress` or `userAgent` in the other items are dropped too, so a caller cannot smuggle them in.
 * - `settingsAt` gives the setting in force at an instant, from the dated changes of the setting. A
 *   change applies to events at or after its instant; evidence already stored is never rewritten,
 *   because nothing here re-reads stored evidence.
 * - `captureChangeAudit` builds the audit entry for a change: actor and time, and the old and new
 *   values.
 *
 * Default: the setting is on. 12 §7 says tenants "can switch off" the capture and does not say the
 * default; the on-by-default reading is the one FRW-042 records and is a proposal for the owner.
 * The administration API that changes the setting, the audit store and the participant endpoints
 * that call `captureEvidence` are the workflow service's and are not built.
 */

/** The tenant's capture setting. */
export interface CaptureSettings {
  readonly captureNetworkIdentity: boolean;
}

/** The setting for a tenant that never changed it (FRW-042 Notes: read as on). */
export const DEFAULT_CAPTURE_SETTINGS: CaptureSettings = { captureNetworkIdentity: true };

/** The keys that carry network identity; never stored while the setting is off. */
const NETWORK_KEYS: ReadonlySet<string> = new Set(['ipAddress', 'userAgent']);

/** One event's facts: the non-network items, and the network identity the request carried. */
export interface EvidenceFacts {
  readonly items: Readonly<Record<string, unknown>>;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

/** The evidence stored for one event. */
export interface CapturedEvidence {
  readonly items: Readonly<Record<string, unknown>>;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
}

/** Builds the evidence of one event under the setting in force for it. */
export function captureEvidence(facts: EvidenceFacts, settings: CaptureSettings): CapturedEvidence {
  const items: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(facts.items)) if (!NETWORK_KEYS.has(k)) items[k] = v;
  if (!settings.captureNetworkIdentity) return { items };
  return { items, ipAddress: facts.ipAddress, userAgent: facts.userAgent };
}

/** A dated change of the setting. */
export interface CaptureChange {
  readonly atMs: number;
  readonly settings: CaptureSettings;
}

/**
 * The setting in force at `instantMs`: the last change at or before it, else `initial`. The changes
 * need not be sorted; the latest one at or before the instant wins, and a later change at the same
 * instant wins over an earlier one in the list.
 */
export function settingsAt(
  changes: readonly CaptureChange[],
  instantMs: number,
  initial: CaptureSettings = DEFAULT_CAPTURE_SETTINGS,
): CaptureSettings {
  let best: CaptureChange | undefined;
  for (const c of changes) {
    if (c.atMs > instantMs) continue;
    if (best === undefined || c.atMs >= best.atMs) best = c;
  }
  return best ? best.settings : initial;
}

/** The audit entry for a change of the setting: who, when, and what from and to. */
export interface CaptureChangeAudit {
  readonly kind: 'capture.setting.changed';
  readonly actor: string;
  readonly atMs: number;
  readonly from: CaptureSettings;
  readonly to: CaptureSettings;
}

export function captureChangeAudit(
  actor: string,
  atMs: number,
  from: CaptureSettings,
  to: CaptureSettings,
): CaptureChangeAudit {
  if (actor.length === 0) throw new RangeError('captureChangeAudit: the actor is empty');
  if (!Number.isSafeInteger(atMs) || atMs < 0)
    throw new RangeError('captureChangeAudit: the time is not a non-negative safe integer');
  return { kind: 'capture.setting.changed', actor, atMs, from, to };
}
