// Routing rules of the workflow resource (FRW-037; 12 §5.1, §6.1): compile-time checks of keys,
// roles and shapes, evaluation of the routes that apply, and a property test on the threshold.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { FieldInfo } from '../src/fields.ts';
import { compileRules } from '../src/language.ts';
import {
  type RoutingEnvironment,
  type RoutingSet,
  compileRouting,
  evaluateRouting,
} from '../src/routing.ts';

const fields: FieldInfo[] = [
  { key: 'lease.total', kind: 'number' },
  { key: 'tenant.name', kind: 'text' },
];
const env: RoutingEnvironment = { fields, roles: ['role_approver', 'role_landlord'] };

const over = (threshold: string) => ({ '>': [{ field: 'lease.total' }, threshold] });
const addApprover = { addParticipant: { role: 'role_approver', order: 2 } };

/** The example of 12 §6.1, compiled. */
function compiled(routing: unknown[], roles = env.roles): RoutingSet {
  const c = compileRouting(routing, { fields, roles });
  if (!c.ok) throw new Error(JSON.stringify(c.problems));
  return c.routing;
}

const codesOf = (json: unknown, e: RoutingEnvironment = env): string[] => {
  const c = compileRouting(json, e);
  return c.ok ? [] : c.problems.map((p) => p.code);
};

describe('routing: compile (FRW-037 criterion 3)', () => {
  it('accepts the example of 12 §6.1', () => {
    const c = compileRouting([{ when: over('50000'), then: [addApprover] }], env);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.routing.routes).toHaveLength(1);
    expect(c.routing.routes[0]!.then).toEqual([
      { k: 'addParticipant', role: 'role_approver', order: 2, path: '/0/then/0' },
    ]);
  });

  it('refuses a field key that does not exist, and a role that does not exist', () => {
    expect(
      codesOf([{ when: { '>': [{ field: 'lease.amount' }, '1'] }, then: [addApprover] }]),
    ).toEqual(['unknown_field']);
    expect(
      codesOf([
        {
          when: over('1'),
          then: [{ addParticipant: { role: 'role_ghost', order: 2 } }],
        },
      ]),
    ).toEqual(['unknown_role']);
    expect(
      codesOf([{ when: over('1'), then: [{ skipParticipant: { role: 'role_ghost' } }] }]),
    ).toEqual(['unknown_role']);
  });

  it('refuses a condition that is not boolean, and a field effect in routing', () => {
    expect(codesOf([{ when: { field: 'lease.total' }, then: [addApprover] }])).toContain(
      'type_mismatch',
    );
    expect(codesOf([{ when: over('1'), then: [{ show: ['tenant.name'] }] }])).toEqual([
      'unknown_effect',
    ]);
    expect(
      codesOf([
        { when: over('1'), then: [{ addParticpant: { role: 'role_approver', order: 2 } }] },
      ]),
    ).toEqual(['unknown_effect']);
  });

  it('refuses an order that is not a positive integer, or missing', () => {
    for (const order of [0, -1, 1.5, '2', null, Number.MAX_SAFE_INTEGER + 2]) {
      expect(
        codesOf([
          { when: over('1'), then: [{ addParticipant: { role: 'role_approver', order } }] },
        ]),
        String(order),
      ).toEqual(['bad_shape']);
    }
    expect(
      codesOf([{ when: over('1'), then: [{ addParticipant: { role: 'role_approver' } }] }]),
    ).toEqual(['bad_shape']);
  });

  it('refuses a route or a list of the wrong shape', () => {
    expect(codesOf({ when: over('1'), then: [] })).toEqual(['bad_shape']);
    expect(codesOf([{ when: over('1') }])).toEqual(['bad_shape']);
    expect(codesOf([{ when: over('1'), then: [], ext: {} }])).toEqual(['bad_shape']);
    expect(codesOf([{ when: over('1'), then: {} }])).toEqual(['bad_shape']);
    expect(
      codesOf([
        {
          when: over('1'),
          then: [
            {
              addParticipant: { role: 'role_approver', order: 2 },
              skipParticipant: { role: 'role_approver' },
            },
          ],
        },
      ]),
    ).toEqual(['bad_shape']);
  });

  it('reports every problem with its path', () => {
    const c = compileRouting(
      [
        { when: { '>': [{ field: 'nope' }, '1'] }, then: [] },
        { when: over('1'), then: [{ addParticipant: { role: 'role_ghost', order: 2 } }] },
      ],
      env,
    );
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(c.problems.map((p) => [p.code, p.path])).toEqual([
      ['unknown_field', '/0/when/>/0'],
      ['unknown_role', '/1/then/0/addParticipant/role'],
    ]);
  });

  it('refuses a routing effect inside a rule_def (FRW-015)', () => {
    const r = compileRules(
      [{ attrs: { id: 'r_route', when: true, then: [addApprover] }, path: '/0' }],
      { fields, roles: env.roles },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems.map((p) => p.code)).toContain('routing_effect');
  });
});

describe('routing: evaluate (FRW-037 criteria 1 and 2, the decision)', () => {
  const routing = compiled([{ when: over('50000'), then: [addApprover] }]);

  it('adds the participant only when the condition is true, at the order given', () => {
    const above = evaluateRouting(routing, { 'lease.total': '60000' }, { roles: [] });
    expect(above).toMatchObject({
      ok: true,
      actions: [{ k: 'addParticipant', route: 0, role: 'role_approver', order: 2 }],
      routes: [{ index: 0, path: '/0', outcome: 'applies' }],
    });
    // The comparison is strict: exactly 50000 does not apply, a fraction above it does.
    const equal = evaluateRouting(routing, { 'lease.total': '50000' }, { roles: [] });
    expect(equal).toMatchObject({ ok: true, actions: [], routes: [{ outcome: 'does_not_apply' }] });
    const just = evaluateRouting(routing, { 'lease.total': '50000.01' }, { roles: [] });
    expect(just).toMatchObject({ ok: true, actions: [{ k: 'addParticipant' }] });
  });

  it('does not apply a route whose condition is unknown (no value entered)', () => {
    const r = evaluateRouting(routing, {}, { roles: [] });
    expect(r).toMatchObject({ ok: true, actions: [], routes: [{ outcome: 'does_not_apply' }] });
  });

  it('reports a condition that fails with its error, and applies nothing for it', () => {
    const r = evaluateRouting(routing, { 'lease.total': 'not a number' }, { roles: [] });
    expect(r).toMatchObject({
      ok: true,
      actions: [],
      routes: [{ outcome: { error: 'invalid_value' } }],
    });
  });

  it('emits skipParticipant for a route whose condition holds, and keeps the others', () => {
    const r = compiled([
      { when: over('50000'), then: [{ skipParticipant: { role: 'role_landlord' } }] },
      { when: over('10'), then: [addApprover] },
    ]);
    const res = evaluateRouting(r, { 'lease.total': '60000' }, { roles: [] });
    expect(res).toMatchObject({
      ok: true,
      actions: [
        { k: 'skipParticipant', route: 0, role: 'role_landlord' },
        { k: 'addParticipant', route: 1, role: 'role_approver', order: 2 },
      ],
    });
    const low = evaluateRouting(r, { 'lease.total': '5' }, { roles: [] });
    expect(low).toMatchObject({ ok: true, actions: [] });
  });

  it('evaluates every route in the order written, with no first match', () => {
    const r = compiled([
      { when: over('1'), then: [addApprover] },
      { when: over('2'), then: [{ addParticipant: { role: 'role_landlord', order: 3 } }] },
    ]);
    const res = evaluateRouting(r, { 'lease.total': '100' }, { roles: [] });
    expect(res.ok && res.actions.map((a) => a.route)).toEqual([0, 1]);
  });

  it('stops with budget_exceeded when the budget is too small', () => {
    const res = evaluateRouting(routing, { 'lease.total': '60000' }, { roles: [], budget: 1 });
    expect(res).toMatchObject({ ok: false, code: 'budget_exceeded' });
  });

  it('applies exactly the routes whose decimal condition is true, for any two integers', () => {
    const big = fc.bigInt({ min: 0n, max: 10n ** 20n });
    fc.assert(
      fc.property(big, big, (total, threshold) => {
        const set = compiled([{ when: over(threshold.toString()), then: [addApprover] }]);
        const res = evaluateRouting(set, { 'lease.total': total.toString() }, { roles: [] });
        if (!res.ok) throw new Error(res.code);
        const applies = total > threshold;
        expect(res.routes[0]!.outcome).toBe(applies ? 'applies' : 'does_not_apply');
        expect(res.actions.length).toBe(applies ? 1 : 0);
      }),
    );
  });
});
