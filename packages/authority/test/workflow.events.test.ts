// The data of the workflow webhooks (FRW-036 criteria 2 and 4): identifiers, seq and chain head only,
// no contact detail, the `dep.workflow.` prefix on every type, and the participant named where the
// event concerns one. The delivery of webhooks is not built (FRW-030, FRW-036 criteria 1, 3 and 5).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  WORKFLOW_EVENTS,
  WORKFLOW_EVENT_PREFIX,
  type WorkflowEventContext,
  type WorkflowEventName,
  workflowEvent,
} from '../src/workflow/events.ts';

const HEX = fc.stringMatching(/^[0-9a-f]{64}$/);
const ID = fc.stringMatching(/^[a-z][a-z0-9_-]{0,30}$/);
const SEQ = fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER });
const PARTICIPANT_EVENTS = new Set<WorkflowEventName>([
  'participant_activated',
  'participant_viewed',
  'field_completed',
  'participant_completed',
  'participant_declined',
  'auth_failed',
  'reminder_due',
]);

describe('the workflow events of 12 §10 (FRW-036 criterion 4)', () => {
  it('lists the thirteen events of 12 §10 in the spec order', () => {
    expect([...WORKFLOW_EVENTS]).toEqual([
      'sent',
      'participant_activated',
      'participant_viewed',
      'field_completed',
      'participant_completed',
      'participant_declined',
      'auth_failed',
      'reminder_due',
      'corrected',
      'voided',
      'expired',
      'completed',
      'finalised',
    ]);
  });

  it('carries the workflow, document and participant identifiers on participant_activated', () => {
    const ev = workflowEvent('participant_activated', {
      workflow: 'wf-1',
      document: 'doc-1',
      seq: 640,
      chainHead: 'c'.repeat(64),
      participant: 'p2',
    });
    expect(ev).toEqual({
      type: 'dep.workflow.participant_activated',
      data: {
        workflow: 'wf-1',
        document: 'doc-1',
        seq: 640,
        chainHead: 'c'.repeat(64),
        participant: 'p2',
      },
    });
  });

  it('refuses a participant event with no participant, so that the host can always name the person', () => {
    for (const name of PARTICIPANT_EVENTS) {
      expect(() =>
        workflowEvent(name, { workflow: 'wf', document: 'doc', seq: 1, chainHead: 'a'.repeat(64) }),
      ).toThrow(RangeError);
    }
  });
});

describe('the data of a workflow webhook holds identifiers only (FRW-036 criterion 2)', () => {
  it('prefixes every type with dep.workflow. and keeps the data to the fixed members', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...WORKFLOW_EVENTS),
        ID,
        ID,
        SEQ,
        HEX,
        ID,
        (name, workflow, document, seq, chainHead, participant) => {
          const ctx: WorkflowEventContext = { workflow, document, seq, chainHead, participant };
          const ev = workflowEvent(name, ctx);
          expect(ev.type.startsWith(WORKFLOW_EVENT_PREFIX)).toBe(true);
          expect(ev.type).toBe(`${WORKFLOW_EVENT_PREFIX}${name}`);
          const keys = Object.keys(ev.data).sort();
          const allowed = PARTICIPANT_EVENTS.has(name)
            ? ['chainHead', 'document', 'participant', 'seq', 'workflow']
            : ['chainHead', 'document', 'seq', 'workflow'];
          expect(keys).toEqual(allowed);
          expect(ev.data.seq).toBe(seq);
          expect(ev.data.chainHead).toBe(chainHead);
        },
      ),
    );
  });

  it('never copies a contact detail or an IP address the caller holds', () => {
    const leaky = {
      workflow: 'wf-9',
      document: 'doc-9',
      seq: 12,
      chainHead: 'e'.repeat(64),
      participant: 'p1',
      email: 'jane.example@mail.invalid',
      phone: '+440000000000',
      ip: '203.0.113.7',
      userAgent: 'agent/1',
      name: 'Jane Example',
    } as WorkflowEventContext;
    const ev = workflowEvent('participant_completed', leaky);
    const text = JSON.stringify(ev);
    for (const secret of [
      'jane.example',
      '+440000000000',
      '203.0.113.7',
      'agent/1',
      'Jane Example',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(Object.keys(ev.data).sort()).toEqual([
      'chainHead',
      'document',
      'participant',
      'seq',
      'workflow',
    ]);
  });

  it('refuses a malformed seq, chain head or identifier rather than raising a bad event', () => {
    const base = { workflow: 'wf', document: 'doc', seq: 1, chainHead: 'a'.repeat(64) };
    expect(() => workflowEvent('sent', { ...base, seq: -1 })).toThrow(RangeError);
    expect(() => workflowEvent('sent', { ...base, seq: 1.5 })).toThrow(RangeError);
    expect(() => workflowEvent('sent', { ...base, chainHead: 'sha256:abc' })).toThrow(RangeError);
    expect(() => workflowEvent('sent', { ...base, workflow: '' })).toThrow(RangeError);
    expect(() => workflowEvent('not_an_event' as WorkflowEventName, base)).toThrow(RangeError);
  });
});
