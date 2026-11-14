/**
 * The evidence items of an evidence bundle, and their verification (12 §8.2 step 4; FRW-055), as pure
 * functions.
 *
 * A bundle holds evidence items, each with its salt, its canonical text and the commitment a control
 * commit carries (FRW-041). `verifyBundle` recomputes every commitment and names each item that does
 * not match, so an altered item fails and is named. The bundle's log segment, its control commits and
 * the chain-head check are the history service's (HIS) and are not part of this module; nor is the
 * endpoint that serves the bundle, or the audit of a retrieval.
 *
 * The instructions state what the evidence proves and what it does not. They claim no verified
 * identity: a participant's authentication is as asserted by the host (FRW-058).
 */
import { SALT_BYTES, verifyEvidence } from './evidence.ts';
import { AUTHENTICATION_PHRASE, findOverclaims } from './language.ts';

export interface BundleItem {
  /** The evidence row's identifier, as the document service names it. */
  readonly id: string;
  /** The salt in lower-case hexadecimal (SALT_BYTES bytes). */
  readonly saltHex: string;
  /** The evidence's canonical text, as the commitment was computed over. */
  readonly canonical: string;
  /** The commitment: lower-case hexadecimal SHA-256 over the salt and the canonical text. */
  readonly commitment: string;
}

export const BUNDLE_INSTRUCTIONS: readonly string[] = [
  'This bundle shows that each listed evidence item matches the salted commitment that its control commit holds.',
  "It does not prove who any participant is. A participant's authentication is as asserted by the host.",
  'It does not prove that a participant read the document or understood it, and it does not establish any signature level.',
  `To check an item, compute SHA-256 over the salt bytes followed by the UTF-8 bytes of the canonical text, and compare the result with the commitment. A participant's authentication is ${AUTHENTICATION_PHRASE}.`,
];

export interface EvidenceBundleFile {
  readonly items: readonly BundleItem[];
  readonly instructions: readonly string[];
}

export type ItemProblem = 'mismatch' | 'malformed_salt' | 'malformed_commitment';

export interface ItemVerdict {
  readonly id: string;
  readonly ok: boolean;
  readonly problem: ItemProblem | null;
}

export interface BundleVerdict {
  /** True only when every item verifies. */
  readonly ok: boolean;
  /** The identifiers of the items that fail, in bundle order. */
  readonly failed: readonly string[];
  readonly items: readonly ItemVerdict[];
}

const HEX = /^[0-9a-f]*$/;
const COMMITMENT = /^[0-9a-f]{64}$/;

/** Decodes lower-case hexadecimal, or returns null when the text is not that shape. */
function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !HEX.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** Assembles a bundle from evidence items. Identifiers must be unique: a duplicate is refused. */
export function buildBundle(items: readonly BundleItem[]): EvidenceBundleFile {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) throw new RangeError(`buildBundle: duplicate evidence id ${item.id}`);
    seen.add(item.id);
  }
  return { items: [...items], instructions: BUNDLE_INSTRUCTIONS };
}

/** Recomputes every commitment in the bundle and names each item that does not verify. */
export async function verifyBundle(bundle: EvidenceBundleFile): Promise<BundleVerdict> {
  const items: ItemVerdict[] = [];
  for (const item of bundle.items) {
    const salt = hexToBytes(item.saltHex);
    if (salt === null || salt.length !== SALT_BYTES) {
      items.push({ id: item.id, ok: false, problem: 'malformed_salt' });
      continue;
    }
    if (!COMMITMENT.test(item.commitment)) {
      items.push({ id: item.id, ok: false, problem: 'malformed_commitment' });
      continue;
    }
    const ok = await verifyEvidence(item.canonical, salt, item.commitment);
    items.push({ id: item.id, ok, problem: ok ? null : 'mismatch' });
  }
  const failed = items.filter((v) => !v.ok).map((v) => v.id);
  return { ok: failed.length === 0, failed, items };
}

/** Whether every instruction of the bundle stays within the legal stance (FRW-058). */
export function instructionsWithinStance(bundle: EvidenceBundleFile): boolean {
  return bundle.instructions.every((line) => findOverclaims(line).length === 0);
}
