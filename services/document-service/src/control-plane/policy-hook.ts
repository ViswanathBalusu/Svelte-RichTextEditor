/**
 * The request to a tenant's data-loss prevention hook (UX-086; 13 section 10; 05 section 7).
 *
 * Before an export or a send, the service asks the tenant's hook whether it may go ahead. This
 * module builds that request: a JSON body with the document, the acting user, the action, the
 * target and the classification label, signed in the same way as a webhook delivery (05 section 7;
 * `webhook-signing.ts`), so the host verifies it with the same verifier. It also reads the answer.
 *
 * Not built here, and kept out on purpose:
 * - the sender: it needs the egress path (BE-056, PRO-071) and a timeout; the timeout and the
 *   outcome when the hook does not answer are an open question, so no default is chosen here;
 * - the calls in the export and send paths, and the audit of a refusal;
 * - where a tenant registers a hook (open question).
 *
 * `decisionOf` returns null for an answer of any other shape. What the service does with null is
 * the caller's decision, and is left open with the timeout.
 */
import { type SignedHeaders, signDelivery } from './webhook-signing.ts';

export type HookAction = 'export' | 'send';

export interface HookRequestInput {
  /** The message identifier, the same on every retry (PRO-071). */
  id: string;
  /** Unix time in whole seconds. */
  timestamp: number;
  /** The tenant's active hook secrets: one while stable, two during a rotation. */
  secrets: readonly string[];
  /** The document's identifier. */
  document: string;
  /** The acting user's surrogate, or `system`. */
  actor: string;
  action: HookAction;
  /** Where the export or the send goes, as the request names it. */
  target: string;
  /** The document's classification label, or null when it has none (UX-085). */
  classification: string | null;
}

export interface HookRequest {
  /** The exact body sent, as text. */
  body: string;
  headers: SignedHeaders & { 'content-type': 'application/json' };
}

export type HookDecision = { allow: true } | { allow: false; reason: string };

const ACTIONS: ReadonlySet<string> = new Set(['export', 'send']);
const MAX_REASON = 500;

function nonEmpty(name: string, value: string): void {
  if (value.trim() === '') throw new TypeError(`the hook request needs ${name}`);
}

/** Builds the signed request. Throws a TypeError when an input is not usable. */
export function hookRequest(input: HookRequestInput): HookRequest {
  nonEmpty('a message identifier', input.id);
  nonEmpty('a document', input.document);
  nonEmpty('an actor', input.actor);
  nonEmpty('a target', input.target);
  if (!ACTIONS.has(input.action)) throw new TypeError('the action is export or send');
  if (input.classification !== null)
    nonEmpty('a classification label or null', input.classification);
  const body = JSON.stringify({
    document: input.document,
    actor: input.actor,
    action: input.action,
    target: input.target,
    classification: input.classification,
  });
  const signed = signDelivery({
    id: input.id,
    timestamp: input.timestamp,
    body,
    secrets: input.secrets,
  });
  return { body, headers: { ...signed, 'content-type': 'application/json' } };
}

/**
 * Reads the hook's answer: `{"decision":"allow"}`, or `{"decision":"deny","reason":"…"}` with a
 * reason of at most 500 characters. Any other shape gives null.
 */
export function decisionOf(answer: unknown): HookDecision | null {
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) return null;
  const { decision, reason } = answer as { decision?: unknown; reason?: unknown };
  if (decision === 'allow') return { allow: true };
  if (
    decision === 'deny' &&
    typeof reason === 'string' &&
    reason.trim() !== '' &&
    reason.length <= MAX_REASON
  )
    return { allow: false, reason };
  return null;
}
