/**
 * Fixtures for the formula operators on decimal strings (FRW-017; ADR 0030 §3): exact addition,
 * multiplication and division truncated to 20 fraction digits, rounding half away from zero,
 * division by zero, overflow, and the worked currency examples of the ADR.
 */
import type { FixtureCase, FixtureGiven } from '../conformance.ts';
import type { FieldInfo } from '../fields.ts';
import {
  bool,
  check,
  choice,
  date,
  day,
  dec,
  err,
  expressionsOf,
  f,
  num,
  p,
  problems,
  str,
  text,
} from './build.ts';

const g = (fields: FieldInfo[], values: FixtureGiven['values'] = {}): FixtureGiven => ({
  fields,
  values,
});
const N = num('n');
const N2 = num('n2');
const T = text('t');
const T2 = text('t2');
const D = date('d');
const D2 = date('d2');
const C = check('c');
const S = choice('status', ['single', 'married']);
const x = expressionsOf('decimal');
const NULL = ['null'];
const TYPE = ['type'];
const CURRENCY = ['currency'];
const long = 'x'.repeat(2100);

export const decimalCases: FixtureCase[] = [
  // +
  x('add.point-one-and-point-two', ['+'], { '+': ['0.1', '0.2'] }, dec('0.3')),
  x('add.canonical-form', ['+'], { '+': [f('n'), '2.20'] }, dec('3.3'), g([N], { n: '1.10' })),
  x(
    'add.beyond-binary-double',
    ['+'],
    { '+': ['12345678901234567890.12', '0.01'] },
    dec('12345678901234567890.13'),
  ),
  x('add.many', ['+'], { '+': ['1', '2', '3.5'] }, dec('6.5')),
  x('add.null', ['+'], { '+': [f('n'), '1'] }, dec(null), g([N], {}), NULL),
  x(
    'add.overflow',
    ['+'],
    { '+': ['9999999999999999999999999999999999999999', '1'] },
    err('decimal', 'overflow'),
  ),
  x('add.type', ['+'], { '+': [f('t'), '1'] }, problems(p('type_mismatch', '/+/0')), g([T]), TYPE),
  x(
    'add.type.not-a-decimal',
    ['+'],
    { '+': [f('n'), 'abc'] },
    problems(p('invalid_literal', '/+/1')),
    g([N]),
    TYPE,
  ),
  x('add.arity', ['+'], { '+': ['1'] }, problems(p('wrong_arity', '/+'))),

  // -
  x('subtract.cents', ['-'], { '-': ['10', '0.01'] }, dec('9.99'), {}, CURRENCY),
  x('subtract.below-zero', ['-'], { '-': ['1', '2.5'] }, dec('-1.5')),
  x('negate', ['-'], { '-': ['5'] }, dec('-5')),
  x('negate.zero', ['-'], { '-': ['0'] }, dec('0')),
  x('subtract.null', ['-'], { '-': [f('n'), '1'] }, dec(null), g([N], {}), NULL),
  x(
    'subtract.type',
    ['-'],
    { '-': [f('d'), '1'] },
    problems(p('type_mismatch', '/-/0')),
    g([D]),
    TYPE,
  ),
  x('subtract.arity', ['-'], { '-': ['1', '2', '3'] }, problems(p('wrong_arity', '/-'))),

  // *
  x('multiply.currency', ['*'], { '*': ['19.99', '3'] }, dec('59.97'), {}, CURRENCY),
  x('multiply.large', ['*'], { '*': ['123456789012345678', '1000'] }, dec('123456789012345678000')),
  x(
    'multiply.truncated-to-20-places',
    ['*'],
    { '*': ['0.00000000001', '0.00000000001'] },
    dec('0'),
  ),
  x('multiply.null', ['*'], { '*': [f('n'), '2'] }, dec(null), g([N], {}), NULL),
  x(
    'multiply.type',
    ['*'],
    { '*': [f('c'), '2'] },
    problems(p('type_mismatch', '/*/0')),
    g([C]),
    TYPE,
  ),

  // /
  x('divide.third', ['/'], { '/': ['100', '3'] }, dec('33.33333333333333333333')),
  x('divide.truncated-not-rounded', ['/'], { '/': ['2', '3'] }, dec('0.66666666666666666666')),
  x('divide.toward-zero', ['/'], { '/': ['-2', '3'] }, dec('-0.66666666666666666666')),
  x('divide.exact', ['/'], { '/': ['10', '4'] }, dec('2.5')),
  x('divide.net-price', ['/'], { '/': ['119.00', '1.19'] }, dec('100'), {}, CURRENCY),
  x('divide.by-zero', ['/'], { '/': ['10', '0'] }, err('decimal', 'division_by_zero')),
  x(
    'divide.by-zero.with-places',
    ['/'],
    { '/': [f('n'), '0.00'] },
    err('decimal', 'division_by_zero'),
    g([N], { n: '0' }),
  ),
  x('divide.null-by-zero', ['/'], { '/': [f('n'), '0'] }, dec(null), g([N], {}), NULL),
  // A JSON Pointer writes the member "/" as "~1" (RFC 6901).
  x('divide.arity', ['/'], { '/': ['1', '2', '3'] }, problems(p('wrong_arity', '/~1'))),
  x(
    'divide.type',
    ['/'],
    { '/': ['1', f('t')] },
    problems(p('type_mismatch', '/~1/1')),
    g([T]),
    TYPE,
  ),

  // round
  x('round.half-away-from-zero', ['round'], { round: ['2.345', 2] }, dec('2.35'), {}, CURRENCY),
  x(
    'round.half-away-from-zero.negative',
    ['round'],
    { round: ['-2.345', 2] },
    dec('-2.35'),
    {},
    CURRENCY,
  ),
  x('round.below-half', ['round'], { round: ['2.344999', 2] }, dec('2.34')),
  x('round.to-integer', ['round'], { round: ['2.5', 0] }, dec('3')),
  x('round.to-integer.negative', ['round'], { round: ['-2.5', 0] }, dec('-3')),
  x(
    'round.vat',
    ['round', '*'],
    { round: [{ '*': ['59.97', '0.19'] }, 2] },
    dec('11.39'),
    {},
    CURRENCY,
  ),
  x(
    'round.gross-price',
    ['round', '*'],
    { round: [{ '*': ['19.99', '1.19'] }, 2] },
    dec('23.79'),
    {},
    CURRENCY,
  ),
  x('round.quotient', ['round', '/'], { round: [{ '/': ['2', '3'] }, 2] }, dec('0.67')),
  x(
    'round.split-a-bill',
    ['round', '/'],
    { round: [{ '/': ['100', '7'] }, 2] },
    dec('14.29'),
    {},
    CURRENCY,
  ),
  x('round.fewer-places-than-asked', ['round'], { round: ['1.5', 3] }, dec('1.5')),
  x('round.null', ['round'], { round: [f('n'), 2] }, dec(null), g([N], {}), NULL),
  x(
    'round.places.out-of-range',
    ['round'],
    { round: [f('n'), 21] },
    problems(p('bad_shape', '/round/1')),
    g([N]),
  ),
  x(
    'round.places.string',
    ['round'],
    { round: [f('n'), '2'] },
    problems(p('bad_shape', '/round/1')),
    g([N]),
  ),
  x(
    'round.type',
    ['round'],
    { round: [f('t'), 2] },
    problems(p('type_mismatch', '/round/0')),
    g([T]),
    TYPE,
  ),

  // sum
  x('sum.skips-empty', ['sum'], { sum: ['10.00', f('n'), '5.50'] }, dec('15.5'), g([N], {}), [
    ...NULL,
    ...CURRENCY,
  ]),
  x('sum.all-empty', ['sum'], { sum: [f('n'), f('n2')] }, dec(null), g([N, N2], {}), NULL),
  x(
    'sum.error',
    ['sum', '/'],
    { sum: ['1', { '/': ['1', '0'] }] },
    err('decimal', 'division_by_zero'),
  ),
  x('sum.one', ['sum'], { sum: ['2.50'] }, dec('2.5')),
  x(
    'sum.overflow',
    ['sum'],
    { sum: ['99999999999999999999999999999999999999999'] },
    err('decimal', 'overflow'),
  ),
  x('sum.type', ['sum'], { sum: [f('t')] }, problems(p('type_mismatch', '/sum/0')), g([T]), TYPE),

  // min and max
  x('min.decimals', ['min'], { min: ['3', '1.5', '2'] }, dec('1.5')),
  x('min.literals-are-numbers', ['min'], { min: ['5', '10'] }, dec('5')),
  x(
    'min.skips-empty',
    ['min'],
    { min: [f('n'), '4', f('n2')] },
    dec('4'),
    g([N, N2], { n2: '7' }),
    NULL,
  ),
  x('max.skips-empty', ['max'], { max: [f('n'), '2', '7.25'] }, dec('7.25'), g([N], {}), NULL),
  x('max.all-empty', ['max'], { max: [f('n')] }, dec(null), g([N], {}), NULL),
  x(
    'min.dates',
    ['min'],
    { min: [f('d'), '2026-02-28'] },
    day('2026-02-28'),
    g([D], { d: '2026-03-01' }),
  ),
  x(
    'max.dates',
    ['max'],
    { max: [f('d'), f('d2')] },
    day('2026-03-01'),
    g([D, D2], { d: '2026-03-01', d2: '2025-12-31' }),
  ),
  x(
    'min.type.decimal-and-date',
    ['min'],
    { min: [f('n'), f('d')] },
    problems(p('type_mismatch', '')),
    g([N, D]),
    TYPE,
  ),
  x('max.type.string', ['max'], { max: [f('t')] }, problems(p('type_mismatch', '')), g([T]), TYPE),

  // concat
  x(
    'concat.names',
    ['concat'],
    { concat: [f('t'), ' ', f('t2')] },
    str('Jane Doe'),
    g([T, T2], { t: 'Jane', t2: 'Doe' }),
  ),
  x(
    'concat.skips-empty',
    ['concat'],
    { concat: [f('t'), f('t2')] },
    str('Jane'),
    g([T, T2], { t: 'Jane' }),
    NULL,
  ),
  x('concat.all-empty', ['concat'], { concat: [f('t')] }, str(null), g([T], {}), NULL),
  x(
    'concat.choice',
    ['concat'],
    { concat: ['Status: ', f('status')] },
    str('Status: married'),
    g([S], { status: 'married' }),
  ),
  x(
    'concat.type.decimal',
    ['concat'],
    { concat: ['Total: ', f('n')] },
    problems(p('type_mismatch', '/concat/1')),
    g([N]),
    TYPE,
  ),
  x(
    'concat.too-long',
    ['concat'],
    { concat: [f('t'), f('t2')] },
    err('string', 'too_long'),
    g([T, T2], { t: long, t2: long }),
  ),

  // if
  x(
    'if.literal-branches-are-strings',
    ['if'],
    { if: [f('c'), '1', '2'] },
    str('1'),
    g([C], { c: true }),
  ),
  x(
    'if.typed-by-the-other-branch',
    ['if'],
    { if: [f('c'), '10', f('n')] },
    dec('10'),
    g([C, N], { c: true, n: '2.5' }),
  ),
  x('if.else', ['if'], { if: [f('c'), f('n'), '0'] }, dec('0'), g([C, N], { c: false, n: '2.5' })),
  x('if.null-condition', ['if'], { if: [f('c'), 'a', 'b'] }, str('b'), g([C], {}), NULL),
  x(
    'if.error-condition',
    ['if', '/'],
    { if: [{ '>': [{ '/': ['1', '0'] }, '1'] }, 'a', 'b'] },
    err('string', 'division_by_zero'),
  ),
  x('if.branch-not-taken', ['if', '/'], { if: [true, '1', { '/': ['1', '0'] }] }, dec('1')),
  x(
    'if.condition-in-a-condition',
    ['if', '=='],
    { '==': [{ if: [f('c'), 'married', 'single'] }, f('status')] },
    bool(true),
    g([C, S], { c: true, status: 'married' }),
  ),
  x(
    'if.type.branches',
    ['if'],
    { if: [f('c'), f('n'), f('t')] },
    problems(p('type_mismatch', '')),
    g([C, N, T]),
    TYPE,
  ),
  x(
    'if.type.condition',
    ['if'],
    { if: [f('n'), 'a', 'b'] },
    problems(p('type_mismatch', '/if/0')),
    g([N]),
    TYPE,
  ),
  x('if.arity', ['if'], { if: [f('c'), 'a'] }, problems(p('wrong_arity', '/if')), g([C])),
];
