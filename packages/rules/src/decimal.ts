/**
 * Decimal arithmetic on decimal strings (12 §5.2; ADR 0030 §3). A decimal is held as a BigInt
 * coefficient and a scale, value = c × 10^-s, so no operation ever passes through a binary float.
 *
 * - Operands are the CDM's decimal strings (no exponent, no leading plus, no leading zeros), read
 *   exactly.
 * - `+` and `-` are exact. `*` is exact, then truncated toward zero to 20 fraction digits. `/` gives
 *   the quotient truncated toward zero to 20 fraction digits; a zero divisor is `division_by_zero`.
 * - `round(x, n)` rounds half away from zero to n places, 0 ≤ n ≤ 20.
 * - A result of magnitude 10^40 or more is `overflow`.
 * - Results are written in canonical form: no trailing fraction zeros, no trailing point, no `-0`.
 *
 * Truncating `/` at 20 digits keeps a later `round` to 19 places or fewer exact: rounding
 * boundaries have at most 20 fraction digits, so truncation never moves a quotient across one.
 */
import { isDecimalString } from '@docedit/model';
import { LIMITS } from './limits.ts';

export interface Decimal {
  /** Coefficient. */
  readonly c: bigint;
  /** Scale: the number of fraction digits, 0 or more. */
  readonly s: number;
}

export type DecimalError = 'overflow' | 'division_by_zero';
export type DecimalResult = Decimal | DecimalError;

const powers: bigint[] = [1n];
/** 10^n as a BigInt. */
export function pow10(n: number): bigint {
  while (powers.length <= n) powers.push(powers[powers.length - 1]! * 10n);
  return powers[n]!;
}

const SCALE = LIMITS.decimalScale;
const LIMIT = pow10(LIMITS.decimalMagnitude);

/** Reads a decimal string exactly; null for anything that is not a CDM decimal string. */
export function parseDecimal(text: string): Decimal | null {
  if (!isDecimalString(text)) return null;
  const negative = text.charCodeAt(0) === 0x2d;
  const body = negative ? text.slice(1) : text;
  const dot = body.indexOf('.');
  const digits = dot < 0 ? body : body.slice(0, dot) + body.slice(dot + 1);
  const c = BigInt(digits);
  return { c: negative ? -c : c, s: dot < 0 ? 0 : body.length - dot - 1 };
}

/** Removes trailing fraction zeros; zero always has scale 0. */
export function normalise(d: Decimal): Decimal {
  let { c, s } = d;
  if (c === 0n) return { c: 0n, s: 0 };
  while (s > 0 && c % 10n === 0n) {
    c /= 10n;
    s--;
  }
  return c === d.c ? d : { c, s };
}

/** The canonical decimal string. */
export function formatDecimal(d: Decimal): string {
  const { c, s } = normalise(d);
  const negative = c < 0n;
  let digits = (negative ? -c : c).toString();
  if (s > 0) {
    digits = digits.padStart(s + 1, '0');
    digits = `${digits.slice(0, digits.length - s)}.${digits.slice(digits.length - s)}`;
  }
  return negative ? `-${digits}` : digits;
}

export const isDecimalError = (r: DecimalResult): r is DecimalError => typeof r === 'string';

/** Truncates toward zero to the fixed scale, then checks the magnitude. */
function finish(c: bigint, s: number): DecimalResult {
  if (s > SCALE) {
    c /= pow10(s - SCALE); // BigInt division truncates toward zero
    s = SCALE;
  }
  const magnitude = c < 0n ? -c : c;
  if (magnitude >= LIMIT * pow10(s)) return 'overflow';
  return { c, s };
}

export function add(a: Decimal, b: Decimal): DecimalResult {
  const s = Math.max(a.s, b.s);
  return finish(a.c * pow10(s - a.s) + b.c * pow10(s - b.s), s);
}

export function subtract(a: Decimal, b: Decimal): DecimalResult {
  return add(a, { c: -b.c, s: b.s });
}

export function negate(a: Decimal): DecimalResult {
  return finish(-a.c, a.s);
}

export function multiply(a: Decimal, b: Decimal): DecimalResult {
  return finish(a.c * b.c, a.s + b.s);
}

export function divide(a: Decimal, b: Decimal): DecimalResult {
  if (b.c === 0n) return 'division_by_zero';
  // a / b = (ca × 10^sb) / (cb × 10^sa); scaled by 10^20 and truncated toward zero.
  return finish((a.c * pow10(b.s + SCALE)) / (b.c * pow10(a.s)), SCALE);
}

/** Rounds half away from zero to `places` fraction digits (0 to 20). */
export function round(a: Decimal, places: number): DecimalResult {
  if (!Number.isInteger(places) || places < 0 || places > LIMITS.roundPlaces)
    throw new RangeError(`round: places must be an integer from 0 to ${LIMITS.roundPlaces}`);
  if (a.s <= places) return finish(a.c, a.s);
  const d = pow10(a.s - places);
  let q = a.c / d;
  const r = a.c - q * d;
  if ((r < 0n ? -r : r) * 2n >= d) q += a.c < 0n ? -1n : 1n;
  return finish(q, places);
}

/** -1, 0 or 1; the comparison is numeric, so "12.5" equals "12.50". */
export function compare(a: Decimal, b: Decimal): -1 | 0 | 1 {
  const s = Math.max(a.s, b.s);
  const x = a.c * pow10(s - a.s);
  const y = b.c * pow10(s - b.s);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Arithmetic on decimal strings, for callers that hold strings (the editor's fields, fixtures). */
export function calculate(
  op: '+' | '-' | '*' | '/',
  a: string,
  b: string,
): { value: string } | { error: DecimalError | 'not_a_decimal' } {
  const x = parseDecimal(a);
  const y = parseDecimal(b);
  if (!x || !y) return { error: 'not_a_decimal' };
  const r =
    op === '+'
      ? add(x, y)
      : op === '-'
        ? subtract(x, y)
        : op === '*'
          ? multiply(x, y)
          : divide(x, y);
  return isDecimalError(r) ? { error: r } : { value: formatDecimal(r) };
}
