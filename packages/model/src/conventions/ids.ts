/**
 * Identifiers (01 §8; FND-003).
 *
 * - Documents, commits, sessions, assets, jobs and threads: UUID version 7 (RFC 9562) in canonical
 *   text form (lower-case hexadecimal, 8-4-4-4-12).
 * - Node identifiers inside a document: 16 characters over the URL-safe Base64 alphabet, generated
 *   randomly by the client that creates the node (03 §9).
 */
import { randomBytes } from './platform.ts';

export type Uuid7 = string & { readonly __brand: 'Uuid7' };
export type NodeId = string & { readonly __brand: 'NodeId' };

export const UUID7_PATTERN =
  '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
export const NODE_ID_PATTERN = '^[A-Za-z0-9_-]{16}$';

const uuid7Re = new RegExp(UUID7_PATTERN);
const nodeIdRe = new RegExp(NODE_ID_PATTERN);

export function isUuid7(value: unknown): value is Uuid7 {
  return typeof value === 'string' && uuid7Re.test(value);
}

export function isNodeId(value: unknown): value is NodeId {
  return typeof value === 'string' && nodeIdRe.test(value);
}

const HEX = '0123456789abcdef';

function hex(bytes: Uint8Array, from: number, to: number): string {
  let out = '';
  for (let i = from; i < to; i++) {
    const b = bytes[i] as number;
    out += HEX[b >> 4]! + HEX[b & 15]!;
  }
  return out;
}

let lastMs = -1;
let lastSeq = 0;

/**
 * A new UUID version 7. Within one millisecond the 12-bit `rand_a` field is used as a counter
 * (RFC 9562 §6.2, method 1), so identifiers made by one process sort in creation order.
 *
 * @param nowMs Unix time in milliseconds; defaults to the local clock. Identifiers are not
 * timestamps: only server-assigned times are trusted (01 §8).
 */
export function uuid7(nowMs: number = Date.now()): Uuid7 {
  let ms = Math.floor(nowMs);
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > 0xffffffffffff) {
    throw new RangeError(`uuid7: timestamp out of range: ${nowMs}`);
  }
  const bytes = randomBytes(16);
  let seq: number;
  if (ms <= lastMs) {
    ms = lastMs;
    seq = lastSeq + 1;
    if (seq > 0xfff) {
      ms += 1;
      seq = ((bytes[6] as number) & 0x0f) * 256 + (bytes[7] as number);
      seq &= 0x7ff;
    }
  } else {
    // Start each millisecond in the lower half so that the counter has room to grow.
    seq = (((bytes[6] as number) & 0x0f) * 256 + (bytes[7] as number)) & 0x7ff;
  }
  lastMs = ms;
  lastSeq = seq;

  // 48-bit big-endian timestamp. Division keeps the arithmetic exact above 2^32.
  const high = Math.floor(ms / 0x1000000);
  const low = ms % 0x1000000;
  bytes[0] = (high >> 16) & 0xff;
  bytes[1] = (high >> 8) & 0xff;
  bytes[2] = high & 0xff;
  bytes[3] = (low >> 16) & 0xff;
  bytes[4] = (low >> 8) & 0xff;
  bytes[5] = low & 0xff;
  bytes[6] = 0x70 | ((seq >> 8) & 0x0f);
  bytes[7] = seq & 0xff;
  bytes[8] = 0x80 | ((bytes[8] as number) & 0x3f);

  return `${hex(bytes, 0, 4)}-${hex(bytes, 4, 6)}-${hex(bytes, 6, 8)}-${hex(bytes, 8, 10)}-${hex(bytes, 10, 16)}` as Uuid7;
}

/** The Unix time in milliseconds encoded in a UUID version 7. */
export function uuid7Time(id: Uuid7): number {
  const h = id.slice(0, 8) + id.slice(9, 13);
  return parseInt(h, 16);
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** A new node identifier: 12 random bytes as 16 characters of URL-safe Base64 (03 §9). */
export function nodeId(): NodeId {
  const bytes = randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i += 3) {
    const n =
      ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
    out +=
      B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]! + B64URL[n & 63]!;
  }
  return out as NodeId;
}
