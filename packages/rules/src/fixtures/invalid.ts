/**
 * Negative fixtures for expressions (FRW-015; ADR 0030 §2, §6): what the language cannot express.
 * There are no loops, no user functions, no code to evaluate, no JSON Logic `var`, no reading of
 * anything but field values, the participant's roles and the date, and no JSON numbers as decimals.
 */
import type { JsonValue } from '@docedit/model';
import type { FixtureCase } from '../conformance.ts';
import { expressionsOf, f, num, p, problems } from './build.ts';

const x = expressionsOf('invalid');
const N = [num('n')];

export const invalidCases: FixtureCase[] = [
  x('literal.json-number', [], { '==': [f('n'), 5] }, problems(p('number_literal', '/==/1')), {
    fields: N,
  }),
  x('literal.list', [], ['a', 'b'], problems(p('bad_shape', ''))),
  x(
    'literal.object-with-two-members',
    [],
    { '==': ['a', 'a'], '!=': ['a', 'b'] },
    problems(p('bad_shape', '')),
  ),
  x('literal.empty-object', [], {}, problems(p('bad_shape', ''))),
  x('operator.unknown', [], { '===': ['a', 'a'] }, problems(p('unknown_operator', ''))),
  x('operator.json-logic-var', [], { var: 'tenant.income' }, problems(p('unknown_operator', ''))),
  x(
    'operator.no-loop',
    [],
    { while: [true, { show: ['x'] }] },
    problems(p('unknown_operator', '')),
  ),
  x(
    'operator.no-map',
    [],
    { map: [f('n'), { '+': ['1', '1'] }] },
    problems(p('unknown_operator', '')),
    { fields: N },
  ),
  x('operator.no-reduce', [], { reduce: [f('n'), '0'] }, problems(p('unknown_operator', '')), {
    fields: N,
  }),
  x(
    'operator.no-functions',
    [],
    { function: { params: ['a'], body: 'return a' } },
    problems(p('unknown_operator', '')),
  ),
  x('operator.no-code', [], { eval: 'globalThis.location' }, problems(p('unknown_operator', ''))),
  x('operator.no-host-data', [], { user: 'email' }, problems(p('unknown_operator', ''))),
  x('operator.effect-is-not-an-operator', [], { show: ['x'] }, problems(p('unknown_operator', ''))),
  x(
    'operator.routing-effect',
    [],
    { addParticipant: { role: 'role_approver' } },
    problems(p('routing_effect', '')),
  ),
  x(
    'operator.too-deep',
    ['not'],
    Array.from({ length: 17 }).reduce<JsonValue>((e) => ({ not: [e] }), true),
    problems(p('too_deep', '')),
  ),
];
