/**
 * The access code of a participant (12 §6.1 `auth`, §7 second bullet; FRW-039 criteria 3 and 5).
 * Pure: the only stored form of a code (a salted SHA-256 hash), the check that a verifier makes
 * against it, and the check that a workflow's `auth` member asks for nothing but an access code.
 * The verify endpoint, the rate limit (criterion 4), the registration of a code and the lockout
 * policy are the workflow service's and are open (FRW-039 Notes; ADR 0341 lane U-FRW-037-054).
 */
import { SHA256_HEX_PATTERN, sha256HexBytes, toHex, utf8 } from '@docedit/model';
import { newEvidenceSalt } from './evidence.ts';

/** The only authentication method a workflow may require of a participant (12 §6.1). */
export const ACCESS_CODE_METHOD = 'access_code';

/** The stored form of a registered code: the salt and the hash, both in lower-case hex. */
export interface AccessCodeRecord {
  readonly method: typeof ACCESS_CODE_METHOD;
  readonly salt: string;
  readonly hash: string;
}

const hexRe = new RegExp(SHA256_HEX_PATTERN);
const SALT_HEX_RE = /^[0-9a-f]{32}$/;

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** The hash of `code` under `salt`: SHA-256 over the salt followed by the UTF-8 code. */
async function codeHash(code: string, salt: Uint8Array): Promise<string> {
  return sha256HexBytes(concat(salt, utf8(code)));
}

/**
 * Registers `code`. The returned record is the only form that may be stored or logged: it holds the
 * salt and the hash, never the code. A code must be a non-empty string; it is hashed as given (no
 * trimming, so a pasted value must match what the participant was sent).
 */
export async function registerAccessCode(
  code: string,
  salt: Uint8Array = newEvidenceSalt(),
): Promise<AccessCodeRecord> {
  if (typeof code !== 'string' || code.length === 0) {
    throw new RangeError('registerAccessCode: the code must be a non-empty string');
  }
  return {
    method: ACCESS_CODE_METHOD,
    salt: toHex(salt),
    hash: await codeHash(code, salt),
  };
}

/**
 * Whether `code` is the code `record` was registered for. The comparison runs over the whole hash
 * and does not stop at the first differing character.
 */
export async function verifyAccessCode(code: string, record: AccessCodeRecord): Promise<boolean> {
  if (typeof code !== 'string' || !SALT_HEX_RE.test(record.salt) || !hexRe.test(record.hash)) {
    return false;
  }
  const computed = await codeHash(code, hexToBytes(record.salt));
  let diff = 0;
  for (let i = 0; i < computed.length; i++)
    diff |= computed.charCodeAt(i) ^ record.hash.charCodeAt(i);
  return diff === 0;
}

/** The result of `checkAuthRequire`: the methods a workflow requires, or why the `auth` is refused. */
export type AuthRequireResult =
  | { readonly ok: true; readonly require: readonly string[] }
  | {
      readonly ok: false;
      readonly reason:
        'not_an_object' | 'require_not_a_list' | 'unsupported_method' | 'unknown_member';
      readonly method?: string;
    };

/**
 * Checks a participant's `auth` member as a workflow is saved (12 §6.1; FRW-039 criterion 5). An
 * absent `auth` requires nothing. Otherwise its only member is `require`, a list whose every entry is
 * `access_code`; any other entry, or any other member, refuses the whole `auth`.
 */
export function checkAuthRequire(auth: unknown): AuthRequireResult {
  if (auth === undefined) return { ok: true, require: [] };
  if (typeof auth !== 'object' || auth === null || Array.isArray(auth)) {
    return { ok: false, reason: 'not_an_object' };
  }
  for (const key of Object.keys(auth)) {
    if (key !== 'require') return { ok: false, reason: 'unknown_member' };
  }
  const methods = (auth as { require?: unknown }).require;
  if (methods === undefined) return { ok: true, require: [] };
  if (!Array.isArray(methods)) return { ok: false, reason: 'require_not_a_list' };
  for (const entry of methods) {
    if (entry !== ACCESS_CODE_METHOD) {
      return typeof entry === 'string'
        ? { ok: false, reason: 'unsupported_method', method: entry }
        : { ok: false, reason: 'unsupported_method' };
    }
  }
  return { ok: true, require: methods.map(() => ACCESS_CODE_METHOD) };
}
