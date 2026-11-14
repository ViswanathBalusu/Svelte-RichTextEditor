/**
 * The audit trail of refused commits (PRM-051 criteria 1, 2 and 4). A commit refused with
 * `permission_denied` or `invalid_op` produces one entry: who sent it, which document, the scopes
 * the check named (none when it named none), the head, the commit identifier and the server time.
 *
 * The entry holds identifiers only. It never carries the steps, the text of the commit or the
 * reason string, because the reason can echo what the client sent. The authority holds no clock,
 * so `time` is given.
 *
 * The room does not call this. The host builds the entry from each `sync.reject` it answers with,
 * because only the host sees every refusal: the room's, the projection gateway's, and those sent to
 * the requester of a server-authored commit (the document service's `room-host.ts`). Storing the
 * entries and querying them (PRM-051 criterion 5) are the host's too.
 */

/** The refusals that leave an audit entry (PRM-051). Other refusals are not audited here. */
export const AUDITED_REJECTION_CODES = ['permission_denied', 'invalid_op'] as const;

export type AuditedRejectionCode = (typeof AUDITED_REJECTION_CODES)[number];

export interface AuditEntry {
  kind: 'commit.rejected';
  code: AuditedRejectionCode;
  /** The user identifier of the connection, or `system` for a server-authored request. */
  actor: string;
  /** The delegated assistant identity acting for `actor`, when there is one (04 G6). */
  agent?: string;
  /** The document identifier, when the room was given it. */
  document?: string;
  /** The scopes the check named, sorted as given. Empty when the check named none. */
  scopes: string[];
  /** The identifier of the refused commit. */
  commit: string;
  /** The document's head when the commit was refused. */
  head: number;
  /** Milliseconds since the epoch, from the room's clock. */
  time: number;
}

export interface RejectionAuditInput {
  code: string;
  actor: string;
  agent?: string | undefined;
  document?: string | undefined;
  scopes?: readonly string[] | undefined;
  commit: string;
  head: number;
  time: number;
}

/**
 * The audit entry for a refusal, or null when the code is not one that is audited. Throws a
 * RangeError when the actor, the commit or the numbers are not usable, so an entry is never stored
 * half-formed.
 */
export function rejectionAudit(input: RejectionAuditInput): AuditEntry | null {
  if (!(AUDITED_REJECTION_CODES as readonly string[]).includes(input.code)) return null;
  if (input.actor.length === 0) throw new RangeError('rejectionAudit: the actor is empty');
  if (!Number.isSafeInteger(input.head) || input.head < 0)
    throw new RangeError('rejectionAudit: the head is not a non-negative safe integer');
  if (!Number.isSafeInteger(input.time) || input.time < 0)
    throw new RangeError('rejectionAudit: the time is not a non-negative safe integer');
  return {
    kind: 'commit.rejected',
    code: input.code as AuditedRejectionCode,
    actor: input.actor,
    ...(input.agent ? { agent: input.agent } : {}),
    ...(input.document !== undefined ? { document: input.document } : {}),
    scopes: [...(input.scopes ?? [])],
    commit: input.commit,
    head: input.head,
    time: input.time,
  };
}
