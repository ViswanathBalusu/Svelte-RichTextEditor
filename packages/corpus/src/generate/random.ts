/**
 * Seeded randomness for the corpus generator (FND-006). Every random choice comes from one of these
 * streams, so two runs produce the same bytes in Node.js and in every browser.
 *
 * - `sfc32` (Chris Doty-Humphrey's small fast counter generator) produces the numbers.
 * - Its four words of state come from `splitmix32`, started from the 32-bit FNV-1a hash of the
 *   stream's seed text. Seeds are ASCII, so hashing UTF-16 code units equals hashing UTF-8 bytes.
 *
 * Only 32-bit integer arithmetic (`Math.imul`, `>>>`, `|`) is used, which ECMAScript specifies
 * exactly. Nothing here reads the clock or the platform's random source.
 */

export const RANDOM_ALGORITHM =
  'sfc32, its state filled by splitmix32 from the 32-bit FNV-1a hash of the seed text';

function fnv1a32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export class Rng {
  #a: number;
  #b: number;
  #c: number;
  #d: number;

  constructor(seed: string) {
    let s = fnv1a32(seed);
    const next = (): number => {
      s = (s + 0x9e3779b9) | 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.#a = next();
    this.#b = next();
    this.#c = next();
    this.#d = next();
    for (let i = 0; i < 12; i++) this.uint32();
  }

  /** The next 32-bit unsigned integer. */
  uint32(): number {
    const a = this.#a;
    const b = this.#b;
    const c = this.#c;
    const d = this.#d;
    const t = (((a + b) | 0) + d) | 0;
    this.#a = b ^ (b >>> 9);
    this.#b = (c + (c << 3)) | 0;
    this.#c = (((c << 21) | (c >>> 11)) + t) | 0;
    this.#d = (d + 1) | 0;
    return t >>> 0;
  }

  /** A number in [0, 1). */
  next(): number {
    return this.uint32() / 4294967296;
  }

  /** An integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** An integer in [min, max], both included. */
  range(min: number, max: number): number {
    return min + this.int(max - min + 1);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('pick from an empty list');
    return items[this.int(items.length)]!;
  }

  bytes(n: number): Uint8Array {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i += 4) {
      let v = this.uint32();
      for (let k = 0; k < 4 && i + k < n; k++) {
        out[i + k] = v & 0xff;
        v >>>= 8;
      }
    }
    return out;
  }
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** A node identifier in the form of 03 §9: 12 random bytes as 16 characters of URL-safe Base64. */
export function nodeIdFrom(rng: Rng): string {
  const bytes = rng.bytes(12);
  let out = '';
  for (let i = 0; i < 12; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out +=
      B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]! + B64URL[n & 63]!;
  }
  return out;
}

/** Identifiers that are unique within one document (invariant I2). */
export class IdSource {
  readonly #rng: Rng;
  readonly #used = new Set<string>();

  constructor(seed: string) {
    this.#rng = new Rng(seed);
  }

  next(): string {
    for (;;) {
      const id = nodeIdFrom(this.#rng);
      if (!this.#used.has(id)) {
        this.#used.add(id);
        return id;
      }
    }
  }
}

const HEX = '0123456789abcdef';

/**
 * A UUID version 7 (RFC 9562) with a fixed timestamp and seeded random bits, so that asset
 * identifiers are stable from run to run. The timestamp is not a creation time.
 */
export function uuid7From(rng: Rng, unixMs: number): string {
  const bytes = rng.bytes(16);
  const high = Math.floor(unixMs / 0x1000000);
  const low = unixMs % 0x1000000;
  bytes[0] = (high >> 16) & 0xff;
  bytes[1] = (high >> 8) & 0xff;
  bytes[2] = high & 0xff;
  bytes[3] = (low >> 16) & 0xff;
  bytes[4] = (low >> 8) & 0xff;
  bytes[5] = low & 0xff;
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  let hex = '';
  for (const b of bytes) hex += HEX[b >> 4]! + HEX[b & 15]!;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
