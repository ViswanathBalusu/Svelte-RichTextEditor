/**
 * Salted commitments to workflow evidence (12 §7; ADR 0013; FRW-041). Evidence is stored outside the
 * commit log, in workflow tables; a control commit for a signing or a completion carries only a
 * salted hash of its evidence. The hash is SHA-256 over the salt followed by the UTF-8 bytes of the
 * canonical evidence text the caller supplies, so a verifier who holds the evidence and the salt can
 * recompute it, and the commit alone reveals nothing about the evidence.
 *
 * This module is the commitment only. The evidence tables, the purge, tenant isolation and the chain
 * are the workflow service's (FRW-041 criteria 1, 3 and 5; FRW-043).
 */
import { SHA256_HEX_PATTERN, randomBytes, sha256HexBytes, utf8 } from '@docedit/model';

/** The salt length in bytes: 128 bits, drawn from the platform's random source. */
export const SALT_BYTES = 16;

const hexRe = new RegExp(SHA256_HEX_PATTERN);

/** A fresh salt for one piece of evidence. */
export function newEvidenceSalt(): Uint8Array {
  return randomBytes(SALT_BYTES);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** The salted hash of `canonical` (the evidence's canonical text) under `salt`, in lower-case hex. */
export async function commitEvidence(canonical: string, salt: Uint8Array): Promise<string> {
  if (salt.length < SALT_BYTES) throw new RangeError('commitEvidence: the salt is too short');
  return sha256HexBytes(concat(salt, utf8(canonical)));
}

/** Whether `canonical` under `salt` is the committed hash (a verifier's recomputation). */
export async function verifyEvidence(
  canonical: string,
  salt: Uint8Array,
  commitment: string,
): Promise<boolean> {
  if (!hexRe.test(commitment)) return false;
  return (await commitEvidence(canonical, salt)) === commitment;
}

/** The part of a control commit that carries evidence: the origin and the salted hash, nothing else. */
export interface EvidenceCommitPayload {
  readonly origin: 'sign' | 'rules' | 'decline';
  readonly evidenceHash: string;
}

/**
 * The evidence part of a control commit for a signing (`sign`) or a completion (`rules`). The salt
 * and the evidence never enter the payload.
 */
export async function controlCommitEvidence(
  origin: EvidenceCommitPayload['origin'],
  canonical: string,
  salt: Uint8Array,
): Promise<EvidenceCommitPayload> {
  return { origin, evidenceHash: await commitEvidence(canonical, salt) };
}
