/**
 * The host's assertions about a participant, as the data plane records them for each open channel
 * (12 §7; 05 §3.1; PRO-015 criterion 3; FRW-038, FRW-040). Lane U-PRO-001-017, round 2.
 *
 * A token may carry `wfp` (the workflow participant), `amr` and `auth_time` (how and when the host
 * authenticated the person). The token service keeps the well-typed ones on the verified identity
 * (`VerifiedIdentity.asserted`, control-plane/tokens.ts). When a channel opens, and again when its
 * token is refreshed, the session records them here with the token's `jti` and the server time.
 *
 * The service does not vouch for them. They are not identity proof, feed no permission check and
 * are never sent on the wire. The record lives as long as the channel; keeping it beyond that is
 * the evidence store of FRW-040, which does not exist yet.
 */
import type { VerifiedIdentity } from '../seams.ts';

/** The claims as the host gave them; each is present only when the token carried it. */
export interface AssertedClaims {
  readonly wfp?: string;
  readonly amr?: readonly string[];
  readonly auth_time?: number;
}

/** The record of one accepted token's assertions on one channel. */
export interface AssertedRecord {
  readonly claims: AssertedClaims;
  /** The `jti` of the token that carried them. */
  readonly jti: string;
  /** When the token was accepted for the channel: server time, Unix milliseconds. */
  readonly recordedAt: number;
}

/**
 * The record of `identity`'s assertions, accepted at `at` (server time), or undefined when the
 * token carries none. The values are copied and frozen, so a later change to the identity cannot
 * change what was recorded.
 */
export function recordAsserted(identity: VerifiedIdentity, at: number): AssertedRecord | undefined {
  const a = identity.asserted;
  if (a === undefined) return undefined;
  const claims: { wfp?: string; amr?: readonly string[]; auth_time?: number } = {};
  if (a.wfp !== undefined) claims.wfp = a.wfp;
  if (a.amr !== undefined) claims.amr = Object.freeze([...a.amr]);
  if (a.auth_time !== undefined) claims.auth_time = a.auth_time;
  if (Object.keys(claims).length === 0) return undefined;
  return Object.freeze({ claims: Object.freeze(claims), jti: identity.jti, recordedAt: at });
}
