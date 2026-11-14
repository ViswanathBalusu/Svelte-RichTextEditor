/**
 * Fixtures for whole rule sets (FRW-015, FRW-017, FRW-019; ADR 0030 §7): every field effect, the
 * example of 12 §5.1, formulas in dependency order whatever order the rules are stored in, errors
 * and null conditions, roles and the date, and the negative cases: cycles, unknown keys,
 * conflicting rules, routing effects in a rule_def and every malformed shape.
 */
import type { JsonValue } from '@docedit/model';
import type { FixtureCase, FixtureGiven } from '../conformance.ts';
import type { FieldInfo } from '../fields.ts';
import { check, choice, date, f, formula, num, p, problems, rules, st, text } from './build.ts';

const r = (id: string, when: JsonValue, then: JsonValue[], otherwise?: JsonValue[]): JsonValue => {
  const rule: Record<string, JsonValue> = { id, when, then };
  if (otherwise) rule['else'] = otherwise;
  return rule;
};
const g = (
  fields: FieldInfo[],
  values: FixtureGiven['values'] = {},
  more: FixtureGiven = {},
): FixtureGiven => ({
  fields,
  values,
  ...more,
});
const set = (field: string, value: JsonValue): JsonValue => ({ set: { field, value } });
const ok = rules.bind(null, 'rules');
const bad = rules.bind(null, 'invalid');

// 12 §5.1: show and require the spouse's name for a married tenant; hide it otherwise.
const SPOUSE_FIELDS = [
  choice('tenant.maritalStatus', ['single', 'married']),
  text('tenant.spouseName'),
];
const SPOUSE = r(
  'r_spouse',
  { '==': [f('tenant.maritalStatus'), 'married'] },
  [{ show: ['tenant.spouseName'] }, { require: ['tenant.spouseName'] }],
  [{ hide: ['tenant.spouseName'] }],
);
const STATUS = st(true, true, false);
const SHOWN_REQUIRED = st(true, true, true, {
  by: { visible: 'r_spouse', required: ['r_spouse'] },
});
const HIDDEN = st(false, true, false, { by: { visible: 'r_spouse' } });

// A chain of formulas: total = a + b, doubled = total × 2, less = doubled − 1.
const CHAIN_FIELDS = [num('a'), num('b'), formula('total'), formula('doubled'), formula('less')];
const R_TOTAL = r('r_total', true, [set('total', { '+': [f('a'), f('b')] })]);
const R_DOUBLED = r('r_doubled', true, [set('doubled', { '*': [f('total'), '2'] })]);
const R_LESS = r('r_less', true, [set('less', { '-': [f('doubled'), '1'] })]);
const CHAIN_EXPECT = {
  fields: {
    a: st(true, true, false),
    b: st(true, true, false),
    total: st(true, true, false, { value: '5', by: { value: 'r_total' } }),
    doubled: st(true, true, false, { value: '10', by: { value: 'r_doubled' } }),
    less: st(true, true, false, { value: '9', by: { value: 'r_less' } }),
  },
  rules: { r_doubled: 'then', r_less: 'then', r_total: 'then' },
};

export const ruleCases: FixtureCase[] = [
  ok(
    'rules.spec-example.married',
    ['==', 'show', 'require', 'hide'],
    [SPOUSE],
    {
      fields: { 'tenant.maritalStatus': STATUS, 'tenant.spouseName': SHOWN_REQUIRED },
      rules: { r_spouse: 'then' },
    },
    g(SPOUSE_FIELDS, { 'tenant.maritalStatus': 'married' }),
    'The example of 12 §5.1 for a married tenant.',
  ),
  ok(
    'rules.spec-example.single',
    ['==', 'show', 'require', 'hide'],
    [SPOUSE],
    {
      fields: { 'tenant.maritalStatus': STATUS, 'tenant.spouseName': HIDDEN },
      rules: { r_spouse: 'else' },
    },
    g(SPOUSE_FIELDS, { 'tenant.maritalStatus': 'single' }),
  ),
  ok(
    'rules.spec-example.not-yet-filled',
    ['==', 'hide'],
    [SPOUSE],
    {
      fields: { 'tenant.maritalStatus': STATUS, 'tenant.spouseName': HIDDEN },
      rules: { r_spouse: 'else' },
    },
    g(SPOUSE_FIELDS, {}),
    'An empty choice is not "married", so the else branch applies.',
  ),
  ok(
    'rules.require.adds-to-static',
    ['require'],
    [r('r', { '==': [f('c'), true] }, [{ require: ['x'] }])],
    {
      fields: { c: st(true, true, false), x: st(true, true, true, { by: { required: ['r'] } }) },
      rules: { r: 'then' },
    },
    g([check('c'), text('x')], { c: true }),
  ),
  ok(
    'rules.require.static-stays',
    ['require'],
    [r('r', { '==': [f('c'), true] }, [{ require: ['x'] }])],
    { fields: { c: st(true, true, false), x: st(true, true, true) }, rules: { r: 'else' } },
    g([check('c'), text('x', { required: true })], { c: false }),
  ),
  ok(
    'rules.require.several-rules',
    ['require'],
    [r('r1', true, [{ require: ['x'] }]), r('r2', true, [{ require: ['x'] }])],
    {
      fields: { x: st(true, true, true, { by: { required: ['r1', 'r2'] } }) },
      rules: { r1: 'then', r2: 'then' },
    },
    g([text('x')]),
  ),
  ok(
    'rules.disable',
    ['disable', 'enable'],
    [r('r', f('c'), [{ disable: ['x'] }], [{ enable: ['x'] }])],
    {
      fields: { c: st(true, true, false), x: st(true, false, false, { by: { enabled: 'r' } }) },
      rules: { r: 'then' },
    },
    g([check('c'), text('x')], { c: true }),
  ),
  ok(
    'rules.enable',
    ['disable', 'enable'],
    [r('r', f('c'), [{ disable: ['x'] }], [{ enable: ['x'] }])],
    {
      fields: { c: st(true, true, false), x: st(true, true, false, { by: { enabled: 'r' } }) },
      rules: { r: 'else' },
    },
    g([check('c'), text('x')], { c: false }),
  ),
  ok(
    'rules.read-only-is-not-lifted',
    ['enable'],
    [r('r', true, [{ enable: ['x'] }])],
    { fields: { x: st(true, false, false, { by: { enabled: 'r' } }) }, rules: { r: 'then' } },
    g([text('x', { readOnly: true })]),
    'Static readOnly wins over enable (12 §3.2: rules can also disable a field).',
  ),
  ok(
    'rules.validate.when-the-condition-fails',
    ['validate', '>='],
    [
      r(
        'r_dates',
        { '>=': [f('end'), f('start')] },
        [],
        [{ validate: { fields: ['end'], message: 'The end date is before the start date.' } }],
      ),
    ],
    {
      fields: {
        start: st(true, true, false),
        end: st(true, true, false, {
          messages: [{ rule: 'r_dates', message: 'The end date is before the start date.' }],
        }),
      },
      rules: { r_dates: 'else' },
    },
    g([date('start'), date('end')], { start: '2026-11-06', end: '2026-11-01' }),
  ),
  ok(
    'rules.validate.passes',
    ['validate', '>='],
    [
      r(
        'r_dates',
        { '>=': [f('end'), f('start')] },
        [],
        [{ validate: { fields: ['end'], message: 'The end date is before the start date.' } }],
      ),
    ],
    {
      fields: { start: st(true, true, false), end: st(true, true, false) },
      rules: { r_dates: 'then' },
    },
    g([date('start'), date('end')], { start: '2026-11-06', end: '2026-11-07' }),
  ),
  ok(
    'rules.validate.null-condition-takes-else',
    ['validate', '>='],
    [
      r(
        'r_dates',
        { '>=': [f('end'), f('start')] },
        [],
        [{ validate: { fields: ['end'], message: 'Enter an end date after the start date.' } }],
      ),
    ],
    {
      fields: {
        start: st(true, true, false),
        end: st(true, true, false, {
          messages: [{ rule: 'r_dates', message: 'Enter an end date after the start date.' }],
        }),
      },
      rules: { r_dates: 'else' },
    },
    g([date('start'), date('end')], { start: '2026-11-06' }),
  ),
  ok(
    'rules.hidden-field-is-not-required',
    ['hide', 'validate'],
    [r('r', true, [{ hide: ['x'] }, { validate: { fields: ['x'], message: 'Never shown.' } }])],
    { fields: { x: st(false, true, false, { by: { visible: 'r' } }) }, rules: { r: 'then' } },
    g([text('x', { required: true })]),
  ),
  ok(
    'rules.formulas.in-dependency-order',
    ['set', '+', '*', '-'],
    [R_LESS, R_DOUBLED, R_TOTAL],
    CHAIN_EXPECT,
    g(CHAIN_FIELDS, { a: '2', b: '3' }),
    'Stored last to first; evaluated first to last.',
  ),
  ok(
    'rules.formulas.in-dependency-order.another-storage-order',
    ['set', '+', '*', '-'],
    [R_DOUBLED, R_TOTAL, R_LESS],
    CHAIN_EXPECT,
    g(CHAIN_FIELDS, { a: '2', b: '3' }),
  ),
  ok(
    'rules.formulas.both-branches.then',
    ['set'],
    [r('r', f('c'), [set('fx', { '*': [f('n'), '2'] })], [set('fx', f('n'))])],
    {
      fields: {
        c: st(true, true, false),
        n: st(true, true, false),
        fx: st(true, true, false, { value: '4', by: { value: 'r' } }),
      },
      rules: { r: 'then' },
    },
    g([check('c'), num('n'), formula('fx')], { c: true, n: '2' }),
  ),
  ok(
    'rules.formulas.both-branches.else',
    ['set'],
    [r('r', f('c'), [set('fx', { '*': [f('n'), '2'] })], [set('fx', f('n'))])],
    {
      fields: {
        c: st(true, true, false),
        n: st(true, true, false),
        fx: st(true, true, false, { value: '2', by: { value: 'r' } }),
      },
      rules: { r: 'else' },
    },
    g([check('c'), num('n'), formula('fx')], { c: false, n: '2' }),
  ),
  ok(
    'rules.formulas.branch-without-set',
    ['set'],
    [r('r', f('c'), [set('fx', '1')])],
    {
      fields: {
        c: st(true, true, false),
        fx: st(true, true, false, { value: null, by: { value: 'r' } }),
      },
      rules: { r: 'else' },
    },
    g([check('c'), formula('fx')], { c: false }),
  ),
  ok(
    'rules.formulas.division-by-zero',
    ['set', '/'],
    [r('r', true, [set('share', { '/': [f('total'), f('people')] })])],
    {
      fields: {
        total: st(true, true, false),
        people: st(true, true, false),
        share: st(true, true, false, {
          value: null,
          error: 'division_by_zero',
          by: { value: 'r' },
        }),
      },
      rules: { r: 'then' },
    },
    g([num('total'), num('people'), formula('share')], { total: '100', people: '0' }),
  ),
  ok(
    'rules.formulas.string',
    ['set', 'concat'],
    [r('r', true, [set('full', { concat: [f('first'), ' ', f('last')] })])],
    {
      fields: {
        first: st(true, true, false),
        last: st(true, true, false),
        full: st(true, true, false, { value: 'Jane Doe', by: { value: 'r' } }),
      },
      rules: { r: 'then' },
    },
    g([text('first'), text('last'), formula('full')], { first: 'Jane', last: 'Doe' }),
  ),
  ok(
    'rules.formulas.read-by-a-condition',
    ['set', '>', 'require', 'sum'],
    [
      r('r_note', { '>': [f('total'), '1000'] }, [{ require: ['note'] }]),
      r('r_total', true, [set('total', { sum: [f('a'), f('b')] })]),
    ],
    {
      fields: {
        a: st(true, true, false),
        b: st(true, true, false),
        total: st(true, true, false, { value: '1200.5', by: { value: 'r_total' } }),
        note: st(true, true, true, { by: { required: ['r_note'] } }),
      },
      rules: { r_note: 'then', r_total: 'then' },
    },
    g([num('a'), num('b'), formula('total'), text('note')], { a: '1000.50', b: '200' }),
  ),
  ok(
    'rules.formulas.stored-value-is-not-read',
    ['set'],
    [r('r', true, [set('fx', { '+': [f('n'), '1'] })])],
    {
      fields: {
        n: st(true, true, false),
        fx: st(true, true, false, { value: '2', by: { value: 'r' } }),
      },
      rules: { r: 'then' },
    },
    g([num('n'), formula('fx')], { n: '1', fx: '999' }),
    'A formula is always computed from its rule; a stale stored value is ignored.',
  ),
  ok(
    'rules.formulas.without-a-rule',
    ['set'],
    [r('r', { '==': [f('fx'), null] }, [{ show: ['x'] }], [{ hide: ['x'] }])],
    {
      fields: {
        fx: st(true, true, false, { value: null }),
        x: st(true, true, false, { by: { visible: 'r' } }),
      },
      rules: { r: 'then' },
    },
    g([formula('fx'), text('x')], { fx: '5' }),
  ),
  ok(
    'rules.condition.error',
    ['set', '/', 'show'],
    [
      r(
        'r',
        { '>': [{ '/': [f('a'), f('b')] }, '1'] },
        [{ show: ['x'] }, set('fx', '1')],
        [{ hide: ['x'] }],
      ),
    ],
    {
      fields: {
        a: st(true, true, false),
        b: st(true, true, false),
        x: st(true, true, false),
        fx: st(true, true, false, { value: null, error: 'division_by_zero', by: { value: 'r' } }),
      },
      rules: { r: 'error:division_by_zero' },
    },
    g([num('a'), num('b'), text('x'), formula('fx')], { a: '1', b: '0' }),
    'A condition that fails applies neither branch; the formula it sets carries the error.',
  ),
  ok(
    'rules.condition.null-takes-else',
    ['>', 'show', 'hide'],
    [r('r', { '>': [f('n'), '5'] }, [{ show: ['x'] }], [{ hide: ['x'] }])],
    {
      fields: { n: st(true, true, false), x: st(false, true, false, { by: { visible: 'r' } }) },
      rules: { r: 'else' },
    },
    g([num('n'), text('x')], {}),
  ),
  ok(
    'rules.condition.checkbox',
    ['field', 'show', 'hide'],
    [r('r', f('agent'), [{ show: ['agent.name'] }], [{ hide: ['agent.name'] }])],
    {
      fields: {
        agent: st(true, true, false),
        'agent.name': st(true, true, false, { by: { visible: 'r' } }),
      },
      rules: { r: 'then' },
    },
    g([check('agent'), text('agent.name')], { agent: true }),
  ),
  ok(
    'rules.role.participant',
    ['role', 'enable', 'disable'],
    [r('r', { role: 'role_tenant' }, [{ enable: ['rent'] }], [{ disable: ['rent'] }])],
    { fields: { rent: st(true, true, false, { by: { enabled: 'r' } }) }, rules: { r: 'then' } },
    g([num('rent')], {}, { roleDefs: ['role_tenant', 'role_landlord'], roles: ['role_tenant'] }),
  ),
  ok(
    'rules.role.preview-as-another-role',
    ['role', 'enable', 'disable'],
    [r('r', { role: 'role_tenant' }, [{ enable: ['rent'] }], [{ disable: ['rent'] }])],
    { fields: { rent: st(true, false, false, { by: { enabled: 'r' } }) }, rules: { r: 'else' } },
    g([num('rent')], {}, { roleDefs: ['role_tenant', 'role_landlord'], roles: ['role_landlord'] }),
    "An author's preview as the landlord: the operand takes the preview's roles.",
  ),
  ok(
    'rules.now.after-a-date',
    ['now', '>', 'require'],
    [r('r', { '>': [{ now: 'date' }, '2026-11-01'] }, [{ require: ['reason'] }])],
    { fields: { reason: st(true, true, true, { by: { required: ['r'] } }) }, rules: { r: 'then' } },
    g(
      [text('reason')],
      {},
      { now: { instant: '2026-11-06T09:00:00.000Z', timeZone: 'Europe/Berlin' } },
    ),
  ),
  ok(
    'rules.else-omitted',
    ['show'],
    [r('r', false, [{ hide: ['x'] }])],
    { fields: { x: st(true, true, false) }, rules: { r: 'else' } },
    g([text('x')]),
  ),
  ok(
    'rules.else-null',
    ['show'],
    [{ id: 'r', when: false, then: [{ hide: ['x'] }], else: null }],
    { fields: { x: st(true, true, false) }, rules: { r: 'else' } },
    g([text('x')]),
  ),

  // Negative fixtures
  bad(
    'rules.cycle.two-formulas',
    ['set'],
    [
      r('rA', true, [set('A', { '+': [f('B'), '1'] })]),
      r('rB', true, [set('B', { '+': [f('A'), '1'] })]),
    ],
    problems(p('cycle', '/0', { keys: ['A', 'B'] })),
    g([formula('A'), formula('B')]),
  ),
  bad(
    'rules.cycle.condition-reads-its-own-formula',
    ['set'],
    [r('r', { '>': [f('A'), '0'] }, [set('A', '1')])],
    problems(p('cycle', '/0', { keys: ['A'] })),
    g([formula('A')]),
  ),
  bad(
    'rules.cycle.three-formulas',
    ['set'],
    [
      r('rA', true, [set('A', f('C'))]),
      r('rB', true, [set('B', f('A'))]),
      r('rC', true, [set('C', f('B'))]),
    ],
    problems(p('cycle', '/0', { keys: ['A', 'B', 'C'] })),
    g([formula('A'), formula('B'), formula('C')]),
  ),
  bad(
    'rules.unknown-field.effect',
    ['show'],
    [r('r', true, [{ show: ['nope'] }])],
    problems(p('unknown_field', '/0/then/0/show/0', { keys: ['nope'] })),
    g([text('x')]),
  ),
  bad(
    'rules.unknown-field.condition',
    ['=='],
    [r('r', { '==': [f('nope'), 'x'] }, [{ show: ['x'] }])],
    problems(p('unknown_field', '/0/when/==/0', { keys: ['nope'] })),
    g([text('x')]),
  ),
  bad(
    'rules.unknown-field.set-value',
    ['set'],
    [r('r', true, [set('fx', { '+': [f('nope'), '1'] })])],
    problems(p('unknown_field', '/0/then/0/set/value/+/0', { keys: ['nope'] })),
    g([formula('fx')]),
  ),
  bad(
    'rules.set.not-a-formula',
    ['set'],
    [r('r', true, [set('t', 'x')])],
    problems(p('not_a_formula', '/0/then/0/set/field', { keys: ['t'] })),
    g([text('t')]),
  ),
  bad(
    'rules.conflict.visibility',
    ['show', 'hide'],
    [r('r1', true, [{ show: ['x'] }]), r('r2', true, [{ hide: ['x'] }])],
    problems(
      p('conflicting_rules', '/0', { keys: ['x'] }),
      p('conflicting_rules', '/1', { keys: ['x'] }),
    ),
    g([text('x')]),
  ),
  bad(
    'rules.conflict.enablement',
    ['enable', 'disable'],
    [r('r1', true, [{ enable: ['x'] }]), r('r2', false, [], [{ disable: ['x'] }])],
    problems(
      p('conflicting_rules', '/0', { keys: ['x'] }),
      p('conflicting_rules', '/1', { keys: ['x'] }),
    ),
    g([text('x')]),
  ),
  bad(
    'rules.conflict.set',
    ['set'],
    [r('r1', true, [set('fx', '1')]), r('r2', true, [set('fx', '2')])],
    problems(
      p('conflicting_rules', '/0', { keys: ['fx'] }),
      p('conflicting_rules', '/1', { keys: ['fx'] }),
    ),
    g([formula('fx')]),
  ),
  bad(
    'rules.conflict.one-branch',
    ['show', 'hide'],
    [r('r', true, [{ show: ['x'] }, { hide: ['x'] }])],
    problems(p('conflicting_effects', '/0/then/1/hide/0', { keys: ['x'] })),
    g([text('x')]),
  ),
  bad(
    'rules.conflict.set-twice',
    ['set'],
    [r('r', true, [set('fx', '1'), set('fx', '2')])],
    problems(p('conflicting_effects', '/0/then/1/set/field', { keys: ['fx'] })),
    g([formula('fx')]),
  ),
  bad(
    'rules.duplicate-key',
    ['show'],
    [r('r', true, [{ show: ['x', 'x'] }])],
    problems(p('duplicate_key', '/0/then/0/show/1', { keys: ['x'] })),
    g([text('x')]),
  ),
  bad(
    'rules.duplicate-rule-identifier',
    ['show'],
    [r('r', true, [{ show: ['x'] }]), r('r', true, [{ require: ['x'] }])],
    problems(p('duplicate_rule', '/1/id')),
    g([text('x')]),
  ),
  bad(
    'rules.routing-effect.add-participant',
    ['addParticipant'],
    [
      r('r', { '>': [f('total'), '50000'] }, [
        { addParticipant: { role: 'role_approver', order: 2 } },
      ]),
    ],
    problems(p('routing_effect', '/0/then/0')),
    g([num('total')]),
    'Routing effects belong to the workflow resource (12 §5.1).',
  ),
  bad(
    'rules.routing-effect.skip-participant',
    ['skipParticipant'],
    [r('r', true, [], [{ skipParticipant: { role: 'role_approver' } }])],
    problems(p('routing_effect', '/0/else/0')),
    g([]),
  ),
  bad(
    'rules.unknown-effect',
    [],
    [r('r', true, [{ lock: ['x'] }])],
    problems(p('unknown_effect', '/0/then/0')),
    g([text('x')]),
  ),
  bad(
    'rules.no-loops',
    [],
    [r('r', true, [{ forEach: { in: 'items', do: [{ show: ['x'] }] } }])],
    problems(p('unknown_effect', '/0/then/0')),
    g([text('x')]),
  ),
  bad(
    'rules.operator-is-not-an-effect',
    [],
    [r('r', true, [{ '==': [f('x'), 'a'] }])],
    problems(p('unknown_effect', '/0/then/0')),
    g([text('x')]),
  ),
  bad(
    'rules.effect-not-an-object',
    [],
    [r('r', true, ['show'])],
    problems(p('bad_shape', '/0/then/0')),
    g([]),
  ),
  bad(
    'rules.validate.no-message',
    ['validate'],
    [r('r', true, [{ validate: { fields: ['x'] } }])],
    problems(p('bad_shape', '/0/then/0/validate')),
    g([text('x')]),
  ),
  bad(
    'rules.validate.message-too-long',
    ['validate'],
    [r('r', true, [{ validate: { fields: ['x'], message: 'm'.repeat(256) } }])],
    problems(p('bad_shape', '/0/then/0/validate/message')),
    g([text('x')]),
  ),
  bad(
    'rules.validate.message-control-character',
    ['validate'],
    [r('r', true, [{ validate: { fields: ['x'], message: 'Ring\u0007' } }])],
    problems(p('bad_shape', '/0/then/0/validate/message')),
    g([text('x')]),
  ),
  bad(
    'rules.set.shape',
    ['set'],
    [r('r', true, [{ set: { field: 'fx' } }])],
    problems(p('bad_shape', '/0/then/0/set')),
    g([formula('fx')]),
  ),
  bad(
    'rules.set.boolean',
    ['set'],
    [r('r', true, [set('fx', { '==': [f('t'), 'a'] })])],
    problems(p('type_mismatch', '/0/then/0/set/value')),
    g([text('t'), formula('fx')]),
    'A formula yields a decimal or a string (12 §3.3).',
  ),
  bad(
    'rules.set.null',
    ['set'],
    [r('r', true, [set('fx', null)])],
    problems(p('type_mismatch', '/0/then/0/set/value')),
    g([formula('fx')]),
  ),
  bad(
    'rules.set.branches-of-different-types',
    ['set'],
    [r('r', f('c'), [set('fx', { '+': [f('n'), '1'] })], [set('fx', { concat: ['none'] })])],
    problems(p('type_mismatch', '/0/else/0', { keys: ['fx'] })),
    g([check('c'), num('n'), formula('fx')]),
  ),
  bad(
    'rules.when.string',
    [],
    [r('r', 'yes', [{ show: ['x'] }])],
    problems(p('type_mismatch', '/0/when')),
    g([text('x')]),
  ),
  bad(
    'rules.when.decimal',
    [],
    [r('r', f('n'), [{ show: ['x'] }])],
    problems(p('type_mismatch', '/0/when')),
    g([num('n'), text('x')]),
  ),
  bad(
    'rules.when.number',
    [],
    [r('r', 1, [{ show: ['x'] }])],
    problems(p('number_literal', '/0/when')),
    g([text('x')]),
  ),
  bad(
    'rules.when.missing',
    [],
    [{ id: 'r', then: [] }],
    problems(p('bad_shape', '/0/when')),
    g([]),
  ),
  bad(
    'rules.then.missing',
    [],
    [{ id: 'r', when: true }],
    problems(p('bad_shape', '/0/then')),
    g([]),
  ),
  bad(
    'rules.else.not-a-list',
    [],
    [{ id: 'r', when: true, then: [], else: {} }],
    problems(p('bad_shape', '/0/else')),
    g([]),
  ),
  bad(
    'rules.extra-member',
    [],
    [{ id: 'r', when: true, then: [], unless: true }],
    problems(p('bad_shape', '/0/unless')),
    g([]),
  ),
  bad(
    'rules.identifier',
    [],
    [{ id: 'r spouse', when: true, then: [] }],
    problems(p('bad_shape', '/0/id')),
    g([]),
  ),
  bad(
    'rules.not-an-object',
    [],
    ['when married show spouse'],
    problems(p('bad_shape', '/0')),
    g([]),
  ),
  bad(
    'rules.too-deep',
    ['not'],
    [
      r(
        'r',
        Array.from({ length: 17 }).reduce<JsonValue>((e) => ({ not: [e] }), true),
        [],
      ),
    ],
    problems(p('too_deep', '/0/when')),
    g([]),
  ),
];
