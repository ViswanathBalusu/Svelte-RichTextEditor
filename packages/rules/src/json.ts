/**
 * Small helpers over JSON values: type tests, JSON Pointers, depth and canonical size. The depth
 * and size rules are the CDM's for `json` attributes (packages/model, grammar-check.ts), so a rule
 * the model accepts by grammar is measured the same way here.
 */
import { canonicalize, escapePointer, utf8, type JsonValue } from '@docedit/model';

export type { JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export const isObject = (v: unknown): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Appends one segment to a JSON Pointer (RFC 6901). */
export const pointer = (base: string, segment: string | number): string =>
  `${base}/${typeof segment === 'number' ? segment : escapePointer(segment)}`;

/** Nesting depth as the CDM grammar counts it: a scalar at the top is depth 1. */
export function jsonDepth(value: unknown, limit = Infinity): number {
  let max = 0;
  const stack: Array<[unknown, number]> = [[value, 1]];
  while (stack.length) {
    const [v, d] = stack.pop()!;
    if (d > max) max = d;
    if (max > limit) return max;
    if (Array.isArray(v)) for (const item of v) stack.push([item, d + 1]);
    else if (isObject(v)) for (const item of Object.values(v)) stack.push([item, d + 1]);
  }
  return max;
}

/** UTF-8 bytes of the RFC 8785 serialisation, or null when the value is not canonicalisable JSON. */
export function canonicalBytes(value: unknown): number | null {
  try {
    return utf8(canonicalize(value)).length;
  } catch {
    return null;
  }
}

/** Unicode code points of a string (lone surrogates count as one each, as JSON Schema counts). */
export function codePointLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

/** UTF-8 length of a string, counting a lone surrogate as the three bytes of U+FFFD. */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

/** C0 controls except tab and line feed, DEL and C1 controls (ADR 0018: free text refuses them). */
export function hasControlCharacter(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c <= 0x1f && c !== 0x09 && c !== 0x0a) || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}

/** Strict code-unit order, never locale order, so that every runtime sorts alike. */
export const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
