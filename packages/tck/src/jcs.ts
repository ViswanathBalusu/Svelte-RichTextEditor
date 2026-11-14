/**
 * An independent implementation of the JSON Canonicalization Scheme (RFC 8785), written from the
 * RFC and not from the model package, so that the canonical-hash fixtures of CDM-011 are checked by
 * a second implementation (PRO-110 criterion 3): object members sorted by the UTF-16 code units of
 * their names, strings escaped minimally, numbers in the ECMAScript form, no whitespace.
 */
import { createHash } from 'node:crypto';

const HEX = '0123456789abcdef';

function quote(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += '\\\\';
    else if (c === 0x08) out += '\\b';
    else if (c === 0x09) out += '\\t';
    else if (c === 0x0a) out += '\\n';
    else if (c === 0x0c) out += '\\f';
    else if (c === 0x0d) out += '\\r';
    else if (c < 0x20) out += `\\u00${HEX[c >> 4]}${HEX[c & 15]}`;
    else out += s[i];
  }
  return `${out}"`;
}

function number(n: number): string {
  if (!Number.isFinite(n)) throw new RangeError('RFC 8785 has no form for NaN or Infinity');
  // RFC 8785 §3.2.2.3 adopts the ECMAScript Number-to-String algorithm; -0 is written as 0.
  return Object.is(n, -0) ? '0' : String(n);
}

/** Compares two strings by their UTF-16 code units (RFC 8785 §3.2.3). */
function byCodeUnits(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a.charCodeAt(i) - b.charCodeAt(i);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

/** The RFC 8785 text of a JSON value. */
export function jcs(v: unknown): string {
  if (v === null) return 'null';
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (typeof v === 'number') return number(v);
  if (typeof v === 'string') return quote(v);
  if (Array.isArray(v)) return `[${v.map(jcs).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort(byCodeUnits);
    return `{${keys.map((k) => `${quote(k)}:${jcs(o[k])}`).join(',')}}`;
  }
  throw new TypeError(`no JSON form for ${typeof v}`);
}

/** Lower-case hexadecimal SHA-256 of the UTF-8 bytes of a text. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
