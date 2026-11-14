// The workflow object of `ch.opened` and `wf.changed` (FRW-035 criteria 1, 2 and 5, the payload
// parts). Pure: the builder is tested; the sending of the message is not built.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type {
  WorkflowParticipant,
  WorkflowRecord,
  WorkflowStateName,
} from '../src/workflow/lifecycle.ts';
import { workflowView, participantStatusWord } from '../src/workflow/state-view.ts';

const p = (
  id: string,
  order: number,
  kind: WorkflowParticipant['kind'] = 'filler',
  completed = false,
  sub?: string,
): WorkflowParticipant =>
  sub === undefined
    ? { id, roles: [`role-${id}`], kind, order, completed }
    : { id, roles: [`role-${id}`], kind, order, completed, sub };

const record = (state: WorkflowStateName, participants: WorkflowParticipant[]): WorkflowRecord => ({
  state,
  participants,
  sentSeq: 12,
  sentHash: 'e'.repeat(64),
  end: null,
});

describe('workflowView (criteria 1 and 2: the complete object with the state and own status)', () => {
  it('carries the state, the send position, the lock and the own status of the connection', () => {
    const r = record('in_progress', [p('a', 1), p('b', 2)]);
    expect(workflowView(r, 'a')).toEqual({
      state: 'in_progress',
      sentSeq: 12,
      lock: { documentState: 'locked', workflowActive: true },
      participant: { id: 'a', kind: 'filler', status: 'active' },
    });
  });

  it('gives a connection that is not a participant no participant entry', () => {
    const r = record('sent', [p('a', 1)]);
    expect(workflowView(r, null).participant).toBeNull();
    expect(workflowView(r, 'nobody').participant).toBeNull();
  });
});

describe('participantStatusWord', () => {
  it('reads the status words from the state and the order', () => {
    expect(participantStatusWord(record('sent', [p('a', 1)]), p('a', 1))).toBe('active');
    expect(participantStatusWord(record('sent', [p('a', 1), p('b', 2)]), p('b', 2))).toBe(
      'waiting',
    );
    expect(
      participantStatusWord(
        record('in_progress', [p('a', 1, 'filler', true)]),
        p('a', 1, 'filler', true),
      ),
    ).toBe('completed');
    expect(participantStatusWord(record('sent', [p('c', 1, 'cc')]), p('c', 1, 'cc'))).toBe('copy');
    expect(participantStatusWord(record('correcting', [p('a', 1)]), p('a', 1))).toBe('paused');
    expect(participantStatusWord(record('expired', [p('a', 1)]), p('a', 1))).toBe('closed');
  });
});

describe('privacy of the object (criterion 5)', () => {
  it('never carries another participant, a sub or a roles list of another participant (property)', () => {
    const states = fc.constantFrom<WorkflowStateName>(
      'draft',
      'sent',
      'in_progress',
      'correcting',
      'completed',
      'finalised',
      'voided',
      'declined',
      'expired',
    );
    const kinds = fc.constantFrom<WorkflowParticipant['kind']>(
      'filler',
      'signer',
      'approver',
      'cc',
    );
    fc.assert(
      fc.property(
        states,
        fc.array(
          fc.record({ kind: kinds, order: fc.integer({ min: 1, max: 3 }), done: fc.boolean() }),
          {
            minLength: 2,
            maxLength: 5,
          },
        ),
        fc.nat(4),
        (state, rows, pick) => {
          const participants = rows.map((row, i) =>
            p(
              `participant-${String(i).padStart(3, '0')}`,
              row.order,
              row.kind,
              row.done,
              `sub-secret-${i}`,
            ),
          );
          const r = record(state, participants);
          const own = participants[pick % participants.length];
          const view = workflowView(r, own?.id ?? null);
          const text = JSON.stringify(view);
          for (const other of participants) {
            if (other.id === own?.id) continue;
            expect(text).not.toContain(other.id);
            expect(text).not.toContain(other.sub ?? '');
            for (const role of other.roles) expect(text).not.toContain(role);
          }
          expect(text).not.toContain('sub-secret');
          expect(Object.keys(view.participant ?? {}).sort()).toEqual(
            view.participant === null ? [] : ['id', 'kind', 'status'],
          );
        },
      ),
    );
  });
});
