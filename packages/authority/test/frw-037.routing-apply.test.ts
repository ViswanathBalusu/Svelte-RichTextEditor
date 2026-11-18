// FRW-037: the routes of a workflow applied to its participants (criteria 1, 2 and 3) as pure
// functions: who is added, who is skipped, who is active afterwards, and the save-time check of the
// routes against a document. The service's use of them is frw-037.routing.test.ts of the document
// service. docs/adr/0405-w4-FRW-037-routing.md (proposed).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  activeParticipantIds,
  applyRouting,
  checkRoutingOfDocument,
  rolesAddedByRouting,
  routeParticipants,
  routedParticipantId,
  sendChecklist,
  type RoutedParticipant,
  type WorkflowParticipant,
} from '../src/index.ts';

interface P extends RoutedParticipant {
  completed?: boolean;
}
const p = (id: string, role: string, order: number, extra: Partial<P> = {}): P => ({
  id,
  roles: [role],
  kind: 'signer',
  order,
  ...extra,
});
const asRecord = (list: readonly P[]): WorkflowParticipant[] =>
  list.map((x) => ({
    id: x.id,
    roles: x.roles,
    kind: x.kind,
    order: x.order,
    completed: x.state === 'completed',
    ...(x.skippedBy !== undefined ? { skipped: true } : {}),
  }));
const activeOf = (list: readonly P[]) => activeParticipantIds(asRecord(list));

/** A document with two roles and the fields of 12 §6.1's example. */
const document = (total: string | null) => ({
  cdm: 1,
  requires: ['fields'],
  doc: {
    type: 'doc',
    content: [
      {
        type: 'defs',
        content: [
          { type: 'role_def', attrs: { id: 'role_tenant', name: 'Tenant', color: '#1F77B4' } },
          { type: 'role_def', attrs: { id: 'role_approver', name: 'Approver', color: '#FF7F0E' } },
        ],
      },
      {
        type: 'paragraph',
        content: [
          {
            type: 'form_field',
            attrs: { id: 'f000000000000001', key: 'lease.total', kind: 'number', value: total },
          },
        ],
      },
    ],
  },
});

const over = (n: string) => ({ '>': [{ field: 'lease.total' }, n] });
const add = { addParticipant: { role: 'role_approver', order: 2 } };
const skip = { skipParticipant: { role: 'role_approver' } };
const facts = (routing: unknown[], total: string | null) => ({
  routing,
  document: document(total),
  instant: '2026-11-18T10:00:00Z',
  timeZone: 'UTC',
});

describe('routing applied to the participants (FRW-037 criterion 1)', () => {
  const base: P[] = [p('p1', 'role_tenant', 1, { state: 'active' })];

  it('adds a participant for the role at the order when the condition holds', () => {
    const r = routeParticipants(base, facts([{ when: over('50000'), then: [add] }], '60000'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changed).toBe(true);
    expect(r.added).toEqual([routedParticipantId(0, 'role_approver')]);
    const added = r.participants.find((x) => x.id === routedParticipantId(0, 'role_approver'))!;
    expect(added).toMatchObject({
      roles: ['role_approver'],
      order: 2,
      kind: 'approver',
      addedBy: 0,
    });
    // It has no person yet: the host has not said who holds the role.
    expect('sub' in added).toBe(false);
  });

  it('adds nobody when the condition is false or the value is empty', () => {
    for (const total of ['50000', '10', null]) {
      const r = routeParticipants(base, facts([{ when: over('50000'), then: [add] }], total));
      expect(r).toMatchObject({ ok: true, changed: false, added: [] });
      if (r.ok) expect(r.participants).toBe(base);
    }
  });

  it('activates the added participant by the ordering rules', () => {
    const r = routeParticipants(base, facts([{ when: over('1'), then: [add] }], '2'));
    if (!r.ok) throw new Error('routing failed');
    // Order 1 is still active; the approver at order 2 waits for it.
    expect(activeOf(r.participants)).toEqual(['p1']);
    const done = r.participants.map((x) => (x.id === 'p1' ? { ...x, state: 'completed' } : x));
    expect(activeOf(done)).toEqual([routedParticipantId(0, 'role_approver')]);

    // An order at or below the one that is active now makes the new participant active at once.
    const front = routeParticipants(
      base,
      facts(
        [{ when: over('1'), then: [{ addParticipant: { role: 'role_approver', order: 1 } }] }],
        '2',
      ),
    );
    if (!front.ok) throw new Error('routing failed');
    expect(activeOf(front.participants)).toEqual(['p1', routedParticipantId(0, 'role_approver')]);
  });

  it('is idempotent: a second evaluation adds nobody and a false condition removes nobody', () => {
    const routing = [{ when: over('1'), then: [add] }];
    const first = routeParticipants(base, facts(routing, '2'));
    if (!first.ok) throw new Error('routing failed');
    const again = routeParticipants(first.participants, facts(routing, '2'));
    expect(again).toMatchObject({ ok: true, changed: false });
    const later = routeParticipants(first.participants, facts(routing, '0'));
    expect(later).toMatchObject({ ok: true, changed: false });
    if (later.ok) expect(later.participants).toHaveLength(2);
  });

  it('reports a route that no longer checks, and applies nothing', () => {
    const r = routeParticipants(
      base,
      facts([{ when: { '>': [{ field: 'lease.gone' }, '1'] }, then: [add] }], '2'),
    );
    expect(r).toMatchObject({ ok: false, code: 'rules_invalid' });
  });

  it('stops with budget_exceeded and applies nothing when the budget runs out', () => {
    const r = routeParticipants(base, {
      ...facts([{ when: over('1'), then: [add] }], '2'),
      budget: 1,
    });
    expect(r).toMatchObject({ ok: false, code: 'budget_exceeded' });
  });
});

describe('routing skips participants (FRW-037 criterion 2)', () => {
  const list: P[] = [
    p('p1', 'role_tenant', 1, { state: 'active' }),
    p('ap', 'role_approver', 2),
    p('p3', 'role_tenant', 3),
  ];

  it('skips the participants who hold the role, and the workflow goes on to the next order', () => {
    const r = routeParticipants(list, facts([{ when: over('1'), then: [skip] }], '2'));
    if (!r.ok) throw new Error('routing failed');
    expect(r.skipped).toEqual(['ap']);
    const done = r.participants.map((x) => (x.id === 'p1' ? { ...x, state: 'completed' } : x));
    // The order after p1 is 3, not the skipped 2.
    expect(activeOf(done)).toEqual(['p3']);
    expect(r.participants.find((x) => x.id === 'ap')).toMatchObject({
      state: 'skipped',
      skippedBy: 0,
    });
  });

  it('does not skip a participant who has completed, or the one named in except', () => {
    const done: P[] = [
      p('a', 'role_approver', 1, { state: 'completed' }),
      p('b', 'role_approver', 2),
    ];
    const r = applyRouting(
      done,
      [{ k: 'skipParticipant', route: 0, role: 'role_approver' }],
      ['b'],
    );
    expect(r.changed).toBe(false);
  });

  it('lets the workflow complete when everyone left is skipped', () => {
    const r = routeParticipants(
      [p('ap', 'role_approver', 1, { state: 'active' })],
      facts([{ when: over('1'), then: [skip] }], '2'),
    );
    if (!r.ok) throw new Error('routing failed');
    expect(activeOf(r.participants)).toEqual([]);
  });

  it('skips a participant a route has added, when a later route says so', () => {
    const r = routeParticipants(
      list,
      facts(
        [
          { when: over('1'), then: [add] },
          { when: over('1'), then: [skip] },
        ],
        '2',
      ),
    );
    if (!r.ok) throw new Error('routing failed');
    expect(r.added).toEqual([routedParticipantId(0, 'role_approver')]);
    expect(r.skipped).toEqual(['ap', routedParticipantId(0, 'role_approver')]);
  });

  it('property: skipped participants are never active and the rest keep their order', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            role: fc.constantFrom('role_tenant', 'role_approver'),
            order: fc.integer({ min: 1, max: 4 }),
          }),
          {
            minLength: 1,
            maxLength: 8,
          },
        ),
        (rows) => {
          const people = rows.map((r, i) => p(`x${i}`, r.role, r.order));
          const out = applyRouting(people, [
            { k: 'skipParticipant', route: 0, role: 'role_approver' },
          ]);
          const active = activeOf(out.participants);
          for (const x of out.participants) {
            if (x.roles.includes('role_approver')) expect(active).not.toContain(x.id);
          }
          const rest = out.participants.filter((x) => !x.roles.includes('role_approver'));
          if (rest.length > 0) {
            const lowest = Math.min(...rest.map((x) => x.order));
            expect(active.sort()).toEqual(
              rest
                .filter((x) => x.order === lowest)
                .map((x) => x.id)
                .sort(),
            );
          } else expect(active).toEqual([]);
        },
      ),
    );
  });
});

describe('routing is checked when the workflow is saved (FRW-037 criterion 3)', () => {
  it('accepts routes whose keys and roles exist and a missing list', () => {
    expect(checkRoutingOfDocument([{ when: over('1'), then: [add] }], document(null))).toEqual({
      ok: true,
    });
    expect(checkRoutingOfDocument(undefined, document(null))).toEqual({ ok: true });
  });

  it('refuses a key that does not exist and a role that does not, each with its path', () => {
    const r = checkRoutingOfDocument(
      [
        { when: { '>': [{ field: 'lease.gone' }, '1'] }, then: [add] },
        { when: over('1'), then: [{ addParticipant: { role: 'role_ghost', order: 2 } }] },
      ],
      document(null),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems.map((x) => [x.code, x.path])).toEqual([
      ['unknown_field', expect.stringMatching(/^\/routing\/0\/when/)],
      ['unknown_role', expect.stringMatching(/^\/routing\/1\/then\/0/)],
    ]);
  });

  it('names the roles a route may add, which need no holder at the send', () => {
    expect(rolesAddedByRouting([{ when: over('1'), then: [add, skip] }, 'not a route'])).toEqual([
      'role_approver',
    ]);
    const held: WorkflowParticipant[] = [
      { id: 'p1', roles: ['role_tenant'], kind: 'signer', order: 1, completed: false },
    ];
    const codes = (routed: string[]) =>
      sendChecklist(document(null), held, routed).map((x) => x.code);
    expect(codes([])).toContain('role_without_participant');
    expect(codes(['role_approver'])).not.toContain('role_without_participant');
  });
});
