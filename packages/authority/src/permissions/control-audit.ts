/**
 * Audit entries for the permission changes that are not refused commits (PRM-052; 07 §14). A
 * region state change, a lease break, a session revocation, a restore and a workflow transition
 * each leave one entry: who acted (and for whom, when an agent acted), the document, the scopes
 * touched, the subject the action named (a region, a lease holder, a revoked user, a workflow),
 * the control commit it was stored under when there is one, and the server time.
 *
 * Like `rejectionAudit` (PRM-051), the entry carries identifiers only. The builder takes exactly
 * these fields, so no steps, text, marks or attributes can reach an entry. The authority holds no
 * clock, so `time` is given. Storing the entries, querying them and the control commit itself are
 * the host's (the control plane stores the change; PRM-052 criteria 1, 2 and 5 are not met here).
 */

/** The changes that leave an entry under PRM-052. */
export const CONTROL_AUDIT_KINDS = [
  'region.state',
  'lease.break',
  'session.revoke',
  'restore',
  'workflow.transition',
] as const;

export type ControlAuditKind = (typeof CONTROL_AUDIT_KINDS)[number];

/**
 * Kinds that must name a subject: the region whose state changed, the lease holder whose lease
 * was broken, the user whose session was revoked, the workflow transition, or the restore's
 * target (a region or a document).
 */
const REQUIRES_SUBJECT: ReadonlySet<ControlAuditKind> = new Set([
  'region.state',
  'lease.break',
  'session.revoke',
  'workflow.transition',
]);

/** Kinds that must name at least one scope. A session revocation may name none. */
const REQUIRES_SCOPE: ReadonlySet<ControlAuditKind> = new Set([
  'region.state',
  'lease.break',
  'restore',
  'workflow.transition',
]);

/** The keys an entry may hold. Nothing else is allowed (PRM-052: identifiers only). */
export const CONTROL_AUDIT_KEYS = [
  'kind',
  'actor',
  'agent',
  'document',
  'scopes',
  'subject',
  'commit',
  'seq',
  'time',
] as const;

export interface ControlAuditEntry {
  kind: ControlAuditKind;
  /** The user identifier of the acting connection, or `system` for a server-authored request. */
  actor: string;
  /** The delegated assistant identity acting for `actor`, when there is one (04 G6). */
  agent?: string;
  /** The document identifier, when the change names one. */
  document?: string;
  /** The scopes touched, sorted and without duplicates. Empty when none were named. */
  scopes: string[];
  /** The identifier the action named: a region, a lease holder, a revoked user or a workflow. */
  subject?: string;
  /** The identifier of the control commit the change is stored under, when it has one. */
  commit?: string;
  /** The document's `seq` the change applies to, when it is known. */
  seq?: number;
  /** Milliseconds since the epoch, from the server's clock. */
  time: number;
}

export interface ControlAuditInput {
  kind: string;
  actor: string;
  agent?: string | undefined;
  document?: string | undefined;
  scopes?: readonly string[] | undefined;
  subject?: string | undefined;
  commit?: string | undefined;
  seq?: number | undefined;
  time: number;
}

/**
 * Identifiers: one to 255 characters with no whitespace and no control characters. `\p{Cc}`
 * covers U+0000 to U+001F, U+007F and the C1 controls U+0080 to U+009F.
 */
const IDENTIFIER_RE = /^[^\s\p{Cc}]{1,255}$/u;

function identifier(name: string, value: string | undefined): void {
  if (value !== undefined && !IDENTIFIER_RE.test(value))
    throw new RangeError(`controlAudit: ${name} is not an identifier`);
}

/**
 * The audit entry for a permission change. Throws a RangeError when the kind is unknown, the
 * actor is missing, a required subject or scope is absent, or an identifier or number is not
 * usable, so an entry is never stored half-formed.
 */
export function controlAudit(input: ControlAuditInput): ControlAuditEntry {
  if (!(CONTROL_AUDIT_KINDS as readonly string[]).includes(input.kind))
    throw new RangeError(`controlAudit: "${input.kind}" is not an audited change`);
  const kind = input.kind as ControlAuditKind;
  if (!IDENTIFIER_RE.test(input.actor))
    throw new RangeError('controlAudit: the actor is not an identifier');
  identifier('agent', input.agent);
  identifier('document', input.document);
  identifier('subject', input.subject);
  identifier('commit', input.commit);
  const scopes = [...new Set(input.scopes ?? [])].sort();
  for (const s of scopes) identifier('scope', s);
  if (REQUIRES_SUBJECT.has(kind) && input.subject === undefined)
    throw new RangeError(`controlAudit: ${kind} names no subject`);
  if (REQUIRES_SCOPE.has(kind) && scopes.length === 0)
    throw new RangeError(`controlAudit: ${kind} names no scope`);
  if (!Number.isSafeInteger(input.time) || input.time < 0)
    throw new RangeError('controlAudit: the time is not a non-negative safe integer');
  if (input.seq !== undefined && (!Number.isSafeInteger(input.seq) || input.seq < 0))
    throw new RangeError('controlAudit: the seq is not a non-negative safe integer');
  return {
    kind,
    actor: input.actor,
    ...(input.agent !== undefined ? { agent: input.agent } : {}),
    ...(input.document !== undefined ? { document: input.document } : {}),
    scopes,
    ...(input.subject !== undefined ? { subject: input.subject } : {}),
    ...(input.commit !== undefined ? { commit: input.commit } : {}),
    ...(input.seq !== undefined ? { seq: input.seq } : {}),
    time: input.time,
  };
}
