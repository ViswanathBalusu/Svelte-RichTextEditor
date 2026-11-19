// What the shell says while a workflow holds the document (FRW-029 criterion 6): the banner's model and
// the words of a refused change. Node.js only; the banner and the notice in the page are run in the
// browser (e2e/frw-029-lock-banner.spec.ts).
import { describe, expect, it } from 'vitest';
import type { RecoveredEdits, WorkflowParticipantView } from '../src/core-api.ts';
import { EN_GB } from '../src/i18n/en-GB.ts';
import { NoticeTracker } from '../src/shell/notices.ts';
import { lockBanner, lockKind, participantLabel, reuseSeq } from '../src/shell/workflow-lock.ts';

const person = (
  id: string,
  name: string | null,
  state: string | null,
  roles: string[] = ['tenant'],
): WorkflowParticipantView => ({ id, name, roles, state });

describe('the states that lock the document (FRW-029 criteria 1 and 5)', () => {
  it('locks while sent or in progress, and stays locked once declined or voided', () => {
    expect(lockKind('sent')).toBe('running');
    expect(lockKind('in_progress')).toBe('running');
    expect(lockKind('declined')).toBe('declined');
    expect(lockKind('voided')).toBe('voided');
  });

  it('says nothing for a draft, an unread workflow, and the states 12 leaves open', () => {
    for (const state of [null, 'draft', 'correcting', 'completed', 'finalised', 'expired'])
      expect(lockKind(state), String(state)).toBeNull();
  });
});

describe('who may still act (FRW-029 criterion 6)', () => {
  const people = [
    person('p1', 'Ada Lovelace', 'active'),
    person('p2', null, 'pending', ['landlord']),
    person('p3', 'Grace Hopper', 'completed'),
    person('p4', '   ', 'active', ['witness', 'notary']),
  ];

  it('lists the participants in state active, by name, else by role, else by identifier', () => {
    expect(lockBanner('in_progress', people)).toEqual({
      kind: 'running',
      actors: ['Ada Lovelace', 'witness, notary'],
    });
    expect(participantLabel(person('p9', null, 'active', []))).toBe('p9');
  });

  it('names nobody for a stopped workflow, and no banner without a lock', () => {
    expect(lockBanner('declined', people)).toEqual({ kind: 'declined', actors: [] });
    expect(lockBanner('voided', people)).toEqual({ kind: 'voided', actors: [] });
    expect(lockBanner('draft', people)).toBeNull();
    expect(lockBanner(null, people)).toBeNull();
  });

  it('shows no one to act when every participant has finished', () => {
    expect(lockBanner('sent', [person('p1', 'Ada', 'completed')])).toEqual({
      kind: 'running',
      actors: [],
    });
  });
});

describe('reusing a stopped workflow’s document (FRW-033 criterion 5)', () => {
  it('offers the copy only for a declined or voided workflow, to a manager, when the host forks, and when the send is known', () => {
    for (const state of ['declined', 'voided'])
      expect(reuseSeq(state, 7, true, true), state).toBe(7);
    // The first commit of a document is seq 0.
    expect(reuseSeq('voided', 0, true, true)).toBe(0);
    for (const state of [
      null,
      'draft',
      'sent',
      'in_progress',
      'correcting',
      'completed',
      'expired',
    ])
      expect(reuseSeq(state, 7, true, true), String(state)).toBeNull();
    expect(reuseSeq('declined', 7, false, true)).toBeNull();
    expect(reuseSeq('declined', 7, true, false)).toBeNull();
    expect(reuseSeq('declined', null, true, true)).toBeNull();
    expect(reuseSeq('declined', -1, true, true)).toBeNull();
    expect(reuseSeq('declined', 1.5, true, true)).toBeNull();
  });

  it('has its words in the source table', () => {
    expect(typeof EN_GB['workflow.banner.reuse']).toBe('string');
    expect(typeof EN_GB['workflow.banner.reuseRequested']).toBe('string');
  });
});

describe('a refused change is explained, not dropped (FRW-029 criterion 6)', () => {
  const refusal = (n: number, reason: string) => ({ n, reason, scopes: ['body'] });

  it('uses the workflow words for a read-only refusal while the document is locked', () => {
    const t = new NoticeTracker(null, undefined);
    expect(t.refusal(refusal(1, 'read-only'), true)?.key).toBe('notice.refused.workflow');
    // Another refusal keeps its own words, and a read-only refusal elsewhere keeps the general ones.
    expect(t.refusal(refusal(2, 'scope'), true)?.key).toBe('notice.refused.scope');
    expect(t.refusal(refusal(3, 'read-only'), false)?.key).toBe('notice.refused.readOnly');
  });

  it('uses the workflow words for a change the service refused as read_only', () => {
    const edits = (count: number): RecoveredEdits => ({
      count,
      items: Array.from({ length: count }, (_, seq) => ({
        reason: 'read_only',
        commit: null,
        text: 'x',
        seq,
        scope: 'body',
      })),
    });
    const t = new NoticeTracker(null, edits(0));
    expect(t.recovered(edits(1), true)?.key).toBe('notice.rejected.workflow');
    expect(t.recovered(edits(2), false)?.key).toBe('notice.rejected.readOnly');
  });

  it('has the words in the source table, with plural forms for the recovered edits', () => {
    expect(typeof EN_GB['notice.refused.workflow']).toBe('string');
    expect(EN_GB['notice.rejected.workflow']).toHaveProperty('one');
    expect(EN_GB['notice.rejected.workflow']).toHaveProperty('other');
    expect(EN_GB['workflow.banner.actors']).toContain('{names}');
  });
});
