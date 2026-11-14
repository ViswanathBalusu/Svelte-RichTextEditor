/**
 * Hashing (FND-005; 01 §8): SHA-256 over the UTF-8 bytes of the RFC 8785 serialisation, written as
 * lower-case hexadecimal. The CDM's own canonical-form rules (03 §2) are applied before this by
 * `canonicalForm` in ../canonical-form.ts.
 */
import { sha256, utf8 } from '../conventions/platform.ts';
import { canonicalize } from './jcs.ts';

export const SHA256_HEX_PATTERN = '^[0-9a-f]{64}$';

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(await sha256(utf8(text)));
}

export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  return toHex(await sha256(bytes));
}

/** SHA-256 of the RFC 8785 form of any JSON value. */
export async function jcsHash(value: unknown): Promise<string> {
  return sha256Hex(canonicalize(value));
}
