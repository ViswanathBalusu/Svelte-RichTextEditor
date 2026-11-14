// Binding people to roles and ordering them (FRW-026 criteria 2 and 5; criterion 1 and 3 are in the
// workflow service and the room, and criterion 4 needs the published schema, FRW-025). Pure functions.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { WorkflowParticipant, WorkflowRecord } from '../src/workflow/lifecycle.ts';
import { activeParticipantIds, completeParticipant } from '../src/workflow/order.ts';
import { checkParticipants } from '../src/workflow/resource.ts';
import { sendChecklist } from '../src/workflow/send.ts';

const running = (participants: WorkflowParticipant[]): WorkflowRecord => ({
  state: 'in_progress',
  participants,
  sentSeq: 10,
  sentHash: 'd'.repeat(64),
  end: null,
});

const roleNode = (id: string) => ({ type: 'role_def', attrs: { id, name: id, color: '#1F77B4' } });
const docOf = (content: unknown[]) => ({ type: 'doc', content });

/** The participants as the host writes them (FRW-026 criterion 1), checked and turned into records. */
function fromHost(list: unknown[]): WorkflowParticipant[] {
  const r = checkParticipants(list);
  if (!r.ok) throw new Error(`the list is refused: ${JSON.stringify(r.problems)}`);
  return r.participants.map((p) => ({
    id: p.id,
    roles: p.roles,
    kind: p.kind,
    order: p.order,
    completed: false,
    ...(p.sub !== undefined ? { sub: p.sub } : {}),
  }));
}

describe('order: equal values run in parallel, ascending values run in sequence (FRW-026 criterion 2)', () => {
  const people = fromHost([
    { id: 'p1', roles: ['role_a'], kind: 'signer', order: 1 },
    { id: 'p2', roles: ['role_b'], kind: 'signer', order: 1 },
    { id: 'p3', roles: ['role_c'], kind: 'signer', order: 2 },
  ]);

  it('makes the two participants of order 1 active together and keeps the one of order 2 waiting', () => {
    expect(activeParticipantIds(people)).toEqual(['p1', 'p2']);
  });

  it('keeps the third participant waiting until both of the first two have completed', () => {
    const afterFirst = completeParticipant(running(people), 'p1');
    expect(afterFirst.ok).toBe(true);
    if (!afterFirst.ok) return;
    expect(activeParticipantIds(afterFirst.record.participants)).toEqual(['p2']);
    expect(afterFirst.completion.activated).toEqual([]);

    const afterSecond = completeParticipant(afterFirst.record, 'p2');
    expect(afterSecond.ok).toBe(true);
    if (!afterSecond.ok) return;
    expect(activeParticipantIds(afterSecond.record.participants)).toEqual(['p3']);
    expect(afterSecond.completion.activated).toEqual(['p3']);
    expect(afterSecond.record.state).toBe('in_progress');
  });

  it('never activates a participant of a higher order while one of a lower order must still act', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ order: fc.integer({ min: 1, max: 4 }), completed: fc.boolean() }), {
          minLength: 1,
          maxLength: 8,
        }),
        (rows) => {
          const list: WorkflowParticipant[] = rows.map((r, i) => ({
            id: `p${i}`,
            roles: [`role_${i}`],
            kind: 'signer',
            order: r.order,
            completed: r.completed,
          }));
          const pending = list.filter((p) => !p.completed);
          const active = activeParticipantIds(list);
          if (pending.length === 0) {
            expect(active).toEqual([]);
            return;
          }
          const lowest = Math.min(...pending.map((p) => p.order));
          expect(active).toEqual(pending.filter((p) => p.order === lowest).map((p) => p.id));
        },
      ),
    );
  });
});

describe('pre-send checklist flags a role with no participant (FRW-026 criterion 5)', () => {
  it('flags the landlord role when only the tenant role is held by a participant', () => {
    const input = docOf([roleNode('role_tenant'), roleNode('role_landlord')]);
    const participants = fromHost([{ id: 'p1', roles: ['role_tenant'], kind: 'signer', order: 1 }]);
    expect(sendChecklist(input, participants)).toEqual([
      { code: 'role_without_participant', roles: ['role_landlord'] },
    ]);
  });

  it('flags nothing when every role of the document is held by some participant', () => {
    const input = docOf([roleNode('role_tenant'), roleNode('role_landlord')]);
    const participants = fromHost([
      { id: 'p1', roles: ['role_tenant'], kind: 'signer', order: 1 },
      { id: 'p2', roles: ['role_landlord', 'role_guarantor'], kind: 'signer', order: 2 },
    ]);
    expect(sendChecklist(input, participants)).toEqual([]);
  });

  it('counts a role as held when two participants hold it', () => {
    const input = docOf([roleNode('role_tenant')]);
    const participants = fromHost([
      { id: 'p1', roles: ['role_tenant'], kind: 'signer', order: 1 },
      { id: 'p2', roles: ['role_tenant'], kind: 'signer', order: 1 },
    ]);
    expect(sendChecklist(input, participants)).toEqual([]);
  });
});
