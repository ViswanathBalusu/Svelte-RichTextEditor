// FRW-086 criterion 2, the freeze at `sentSeq` (docs/adr/0381-w4-FRW-086-long-answers-under-a-lock.md):
// the comparison of `resume` leaves out the content of the regions granted to roles, because the
// participant who holds the role may edit them while the workflow runs (07 §4 limit 1). Anything
// else in the body is still a change, and so is the region itself.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compareWithSent, resumeWorkflow } from '../src/workflow/correction.ts';
import type { WorkflowParticipant, WorkflowRecord } from '../src/workflow/lifecycle.ts';
import { fieldOwnersOf, snapshotOf } from '../src/workflow/snapshot.ts';

type J = Record<string, unknown>;

const paragraph = (id: string, text: string): J => ({
  type: 'paragraph',
  attrs: { id },
  content: [{ type: 'text', text }],
});
const region = (id: string, title: string, ...content: J[]): J => ({
  type: 'region',
  attrs: { id, title, policy: 'restricted' },
  content,
});
const field = (key: string, assignee: string, value: unknown = null): J => ({
  type: 'form_field',
  attrs: { id: `f-${key}`, key, kind: 'text', label: key, assignee, value },
});

/** A document with an intro, a region granted to a role and a closing paragraph. */
function doc(intro: string, answer: string, closing = 'The end.', title = 'Answer'): J {
  return {
    cdm: 1,
    requires: ['fields'],
    doc: {
      type: 'doc',
      content: [
        {
          type: 'defs',
          content: [
            { type: 'role_def', attrs: { id: 'tenant', name: 'Tenant', color: '#1F77B4' } },
          ],
        },
        {
          type: 'body',
          content: [
            paragraph('pIntro', intro),
            region('rAnswer', title, paragraph('pAnswer', answer)),
            paragraph('pEnd', closing),
          ],
        },
      ],
    },
  };
}

const GRANTED = new Set(['rAnswer']);
const NONE = new Set<string>();

describe('the snapshot leaves out the content of a region granted to a role (FRW-086)', () => {
  it('has the same body whatever the region holds, when the region is named', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), fc.string({ maxLength: 40 }), (a, b) => {
        expect(snapshotOf(doc('Intro', a), GRANTED).body).toBe(
          snapshotOf(doc('Intro', b), GRANTED).body,
        );
      }),
    );
  });

  it('compares the region as before when it is not named', () => {
    expect(snapshotOf(doc('Intro', 'one'), NONE).body).not.toBe(
      snapshotOf(doc('Intro', 'two'), NONE).body,
    );
    expect(snapshotOf(doc('Intro', 'one')).body).not.toBe(snapshotOf(doc('Intro', 'two')).body);
  });

  it('still sees a change outside the region, and a change of the region itself', () => {
    const sent = snapshotOf(doc('Intro', 'one'), GRANTED);
    expect(snapshotOf(doc('Changed', 'one'), GRANTED).body).not.toBe(sent.body);
    expect(snapshotOf(doc('Intro', 'one', 'Changed'), GRANTED).body).not.toBe(sent.body);
    expect(snapshotOf(doc('Intro', 'one', 'The end.', 'Renamed'), GRANTED).body).not.toBe(
      sent.body,
    );
  });

  it('keeps the values of fields inside the region in the comparison', () => {
    const withField = (value: string): J => {
      const d = doc('Intro', 'one') as { doc: { content: Array<{ content: J[] }> } };
      const inner = (d.doc.content[1]!.content[1] as { content: J[] }).content;
      inner.push({
        type: 'paragraph',
        attrs: { id: 'pField' },
        content: [field('tenant.note', 'tenant', value)],
      });
      return d as unknown as J;
    };
    const change = compareWithSent(
      snapshotOf(withField('a'), GRANTED),
      snapshotOf(withField('b'), GRANTED),
    );
    expect(change).toEqual({ bodyChanged: false, changedFields: ['tenant.note'] });
  });

  it('does not reset a participant who completed when only the granted region changed', () => {
    const people: WorkflowParticipant[] = [
      { id: 't', roles: ['tenant'], kind: 'signer', order: 1, completed: true },
    ];
    const record: WorkflowRecord = {
      state: 'correcting',
      participants: people,
      sentSeq: 3,
      sentHash: 'a'.repeat(64),
      end: null,
    };
    const resetAfter = (head: J, granted: ReadonlySet<string>): string[] => {
      const change = compareWithSent(
        snapshotOf(doc('Intro', 'one'), granted),
        snapshotOf(head, granted),
      );
      const out = resumeWorkflow(record, { manage: true }, change, fieldOwnersOf(head, people));
      if (!out.ok) throw new Error('a correcting workflow must resume');
      return [...out.reset];
    };
    // Only the region changed: nobody is reset when it is granted; the whole body counts when not.
    expect(resetAfter(doc('Intro', 'written by the participant'), GRANTED)).toEqual([]);
    expect(resetAfter(doc('Intro', 'written by the participant'), NONE)).toEqual(['t']);
    // A change outside the region resets, granted or not.
    expect(resetAfter(doc('Corrected', 'one'), GRANTED)).toEqual(['t']);
  });
});
