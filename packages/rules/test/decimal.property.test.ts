// Decimal arithmetic (FRW-017; ADR 0030 §3) against an independent reference: exact rationals as
// BigInt numerators over powers of ten, compared by cross-multiplication. Property tests with
// fast-check.
import { isDecimalString } from '@docedit/model';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type Decimal,
  add,
  compare,
  divide,
  formatDecimal,
  isDecimalError,
  multiply,
  parseDecimal,
  pow10,
  round,
  subtract,
} from '../src/decimal.ts';

const digits = (max: number) =>
  fc.string({ unit: fc.constantFrom(...'0123456789'), maxLength: max });

/** CDM decimal strings with up to 25 integer digits and up to 20 fraction digits. */
const decimalText = fc
  .record({
    negative: fc.boolean(),
    int: fc.bigInt({ min: 0n, max: 10n ** 25n - 1n }),
    frac: digits(20),
  })
  .map(({ negative, int, frac }) => `${negative ? '-' : ''}${int}${frac ? `.${frac}` : ''}`);

const d = (text: string): Decimal => parseDecimal(text)!;
const abs = (x: bigint) => (x < 0n ? -x : x);
const sign = (x: bigint) => (x < 0n ? -1 : x > 0n ? 1 : 0);
/** a.c × 10^-a.s versus b.c × 10^-b.s, exactly. */
const cmp = (a: Decimal, b: Decimal) => sign(a.c * pow10(b.s) - b.c * pow10(a.s));

describe('decimal strings', () => {
  it('reads every CDM decimal string and writes the canonical form', () => {
    fc.assert(
      fc.property(decimalText, (text) => {
        expect(isDecimalString(text)).toBe(true);
        const x = d(text);
        const out = formatDecimal(x);
        expect(isDecimalString(out)).toBe(true);
        expect(cmp(d(out), x)).toBe(0);
        expect(formatDecimal(d(out))).toBe(out);
        expect(out).not.toMatch(/\.\d*0$|^-0$|\.$/);
      }),
    );
  });

  it('refuses what is not a CDM decimal string', () => {
    for (const s of [
      '1e3',
      '+1',
      '01',
      '.5',
      '1.',
      '1,5',
      ' 1',
      '0x10',
      'NaN',
      'Infinity',
      '',
      '-',
      '1'.repeat(65),
    ])
      expect(parseDecimal(s), s).toBeNull();
  });
});

describe('arithmetic', () => {
  it('adds and subtracts exactly', () => {
    fc.assert(
      fc.property(decimalText, decimalText, (a, b) => {
        const x = d(a);
        const y = d(b);
        const s = add(x, y);
        const t = subtract(x, y);
        if (isDecimalError(s) || isDecimalError(t)) throw new Error('no overflow below 10^26');
        // s - x - y = 0 exactly: s.c/10^s.s = x.c/10^x.s + y.c/10^y.s
        const scale = Math.max(x.s, y.s, s.s, t.s);
        const at = (v: Decimal) => v.c * pow10(scale - v.s);
        expect(at(s)).toBe(at(x) + at(y));
        expect(at(t)).toBe(at(x) - at(y));
      }),
    );
  });

  it('multiplies exactly, truncating toward zero beyond 20 fraction digits', () => {
    fc.assert(
      fc.property(decimalText, decimalText, (a, b) => {
        const x = d(a);
        const y = d(b);
        const p = multiply(x, y);
        const exact = { c: x.c * y.c, s: x.s + y.s };
        // Truncated toward zero to 20 fraction digits, the value is 10^40 or more exactly when the
        // result is `overflow`.
        const ts = Math.min(exact.s, 20);
        const tc = exact.c / pow10(exact.s - ts);
        expect(p === 'overflow').toBe(abs(tc) >= pow10(40 + ts));
        if (isDecimalError(p)) return;
        expect(p.s).toBeLessThanOrEqual(20);
        // |p| ≤ |exact| < |p| + 10^-20, with the sign of exact (or zero).
        const scale = Math.max(exact.s, 20);
        const e = exact.c * pow10(scale - exact.s);
        const q = p.c * pow10(scale - p.s);
        expect(abs(q) <= abs(e)).toBe(true);
        expect(abs(e) < abs(q) + pow10(scale - 20)).toBe(true);
        if (q !== 0n) expect(sign(q)).toBe(sign(e));
      }),
    );
  });

  it('divides, truncating the quotient toward zero at 20 fraction digits', () => {
    fc.assert(
      fc.property(decimalText, decimalText, (a, b) => {
        const x = d(a);
        const y = d(b);
        const q = divide(x, y);
        if (y.c === 0n) {
          expect(q).toBe('division_by_zero');
          return;
        }
        if (q === 'overflow') return; // |x / y| ≥ 10^40 is possible with a tiny divisor
        if (isDecimalError(q)) throw new Error(q);
        // |q| ≤ |x/y| < |q| + 10^-20, by cross-multiplication with no division at all.
        const qn = q.c * pow10(20 - q.s); // q as n / 10^20
        const lhs = abs(qn) * abs(y.c) * pow10(x.s);
        const mid = abs(x.c) * pow10(y.s) * pow10(20);
        const rhs = (abs(qn) + 1n) * abs(y.c) * pow10(x.s);
        expect(lhs <= mid && mid < rhs).toBe(true);
        if (qn !== 0n) expect(sign(qn)).toBe(sign(x.c) * sign(y.c));
      }),
    );
  });

  it('rounds half away from zero', () => {
    fc.assert(
      fc.property(decimalText, fc.integer({ min: 0, max: 20 }), (a, places) => {
        const x = d(a);
        const r = round(x, places);
        if (isDecimalError(r)) throw new Error(r);
        expect(r.s).toBeLessThanOrEqual(places);
        // The distance to x is at most half a unit in the last place, and a tie goes away from zero.
        const scale = Math.max(x.s, places) + 1;
        const xs = x.c * pow10(scale - x.s);
        const rs = r.c * pow10(scale - r.s);
        const half = 5n * pow10(scale - places - 1);
        const dist = abs(xs - rs);
        expect(dist <= half).toBe(true);
        if (dist === half) expect(abs(rs) > abs(xs)).toBe(true);
      }),
    );
  });

  it('compares numerically, whatever the scale', () => {
    fc.assert(
      fc.property(decimalText, decimalText, (a, b) => {
        expect(compare(d(a), d(b))).toBe(cmp(d(a), d(b)));
        expect(compare(d(a), d(`${a}${a.includes('.') ? '' : '.'}000`))).toBe(0);
      }),
    );
  });

  it('keeps the worked examples of ADR 0030', () => {
    const calc = (op: (a: Decimal, b: Decimal) => unknown, a: string, b: string) => {
      const r = op(d(a), d(b)) as Decimal | string;
      return typeof r === 'string' ? r : formatDecimal(r);
    };
    const r2 = (x: Decimal | string) =>
      typeof x === 'string' ? x : formatDecimal(round(x, 2) as Decimal);
    expect(calc(add, '0.1', '0.2')).toBe('0.3');
    expect(calc(add, '1.10', '2.20')).toBe('3.3');
    expect(calc(multiply, '19.99', '3')).toBe('59.97');
    expect(r2(multiply(d('59.97'), d('0.19')))).toBe('11.39');
    expect(r2(multiply(d('19.99'), d('1.19')))).toBe('23.79');
    expect(r2(d('2.345'))).toBe('2.35');
    expect(r2(d('-2.345'))).toBe('-2.35');
    expect(calc(divide, '100', '3')).toBe('33.33333333333333333333');
    expect(calc(divide, '2', '3')).toBe('0.66666666666666666666');
    expect(r2(divide(d('2'), d('3')))).toBe('0.67');
    expect(r2(divide(d('100'), d('7')))).toBe('14.29');
    expect(calc(divide, '119.00', '1.19')).toBe('100');
    expect(calc(divide, '10', '0')).toBe('division_by_zero');
    expect(calc(add, '12345678901234567890.12', '0.01')).toBe('12345678901234567890.13');
    expect(calc(add, '9999999999999999999999999999999999999999', '1')).toBe('overflow');
    expect(calc(multiply, '0.00000000001', '0.00000000001')).toBe('0');
  });
});
