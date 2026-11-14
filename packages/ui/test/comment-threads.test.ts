/**
 * Thread state rules (UX-029 criteria 3, 4 and 6; UX-030 criterion 1 and the name of criterion 6;
 * UX-032 criteria 1 and 2; UX-034 criteria 1 and 3). Pure functions only; the controls, the live
 * refresh and the clipboard are not built.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Capability } from '../src/core-api.ts';
import {
  anchorAfterInsertion,
  anchorAfterRemoval,
  anchorAfterUndo,
  assignThread,
  commentLinkRequest,
  paneRows,
  PRECONDITION_FAILED,
  resolveCommentLink,
  setThreadState,
  writeOutcome,
  type Anchor,
  type ThreadInput,
} from '../src/shell/comment-threads.ts';

const CAPS: readonly Capability[] = [
  'view',
  'comment',
  'suggest',
  'edit',
  'fill',
  'structure',
  'manage',
];
const capsArb = fc.subarray([...CAPS]);
const NAMES = ['ann', 'ben', 'cy', 'dee'] as const;

describe('resolve and reopen (UX-029 criterion 3, the rule part)', () => {
  it('lets a user with comment resolve and reopen, and refuses without it', () => {
    const open = { id: 't1', state: 'open' as const };
    const resolved = setThreadState(open, 'resolved', ['comment']);
    expect(resolved).toEqual({ ok: true, thread: { id: 't1', state: 'resolved' } });
    expect(setThreadState(open, 'resolved', ['view', 'suggest'])).toEqual({
      ok: false,
      reason: 'noComment',
    });
  });

  it('never changes the input and keeps every other field (property)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('open', 'resolved') as fc.Arbitrary<'open' | 'resolved'>,
        fc.constantFrom('open', 'resolved') as fc.Arbitrary<'open' | 'resolved'>,
        capsArb,
        (from, to, caps) => {
          const thread = { id: 't', state: from, assignee: 'ann' as string | null };
          const result = setThreadState(thread, to, caps);
          expect(thread.state).toBe(from);
          if (caps.includes('comment')) {
            expect(result).toEqual({ ok: true, thread: { id: 't', state: to, assignee: 'ann' } });
          } else {
            expect(result).toEqual({ ok: false, reason: 'noComment' });
          }
        },
      ),
    );
  });
});

describe('the commented range and detached threads (UX-029 criterion 4)', () => {
  const attached: Anchor = { status: 'attached', from: 10, to: 20 };

  it('detaches a range whose text is all removed, and keeps it detached after undo', () => {
    const detached = anchorAfterRemoval(attached, { from: 10, to: 20 });
    expect(detached).toEqual({ status: 'detached' });
    // Undo restores the text in the document; the anchor is not re-attached.
    expect(anchorAfterUndo(detached)).toEqual({ status: 'detached' });
  });

  it('keeps the range when only part of its text is removed', () => {
    expect(anchorAfterRemoval(attached, { from: 12, to: 15 })).toEqual({
      status: 'attached',
      from: 10,
      to: 17,
    });
  });

  it('shifts the range for removals before it and after it', () => {
    expect(anchorAfterRemoval(attached, { from: 0, to: 4 })).toEqual({
      status: 'attached',
      from: 6,
      to: 16,
    });
    expect(anchorAfterRemoval(attached, { from: 30, to: 40 })).toEqual(attached);
  });

  it('is final: a detached anchor stays detached under any later change (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 50 }),
        fc.integer({ min: 0, max: 50 }),
        fc.integer({ min: 0, max: 20 }),
        (a, b, n) => {
          const detached: Anchor = { status: 'detached' };
          expect(anchorAfterInsertion(detached, { at: a, length: n })).toEqual(detached);
          expect(
            anchorAfterRemoval(detached, { from: Math.min(a, b), to: Math.max(a, b) }),
          ).toEqual(detached);
          expect(anchorAfterUndo(detached)).toEqual(detached);
        },
      ),
    );
  });

  it('never detaches an empty range by a removal (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 40 }), fc.integer({ min: 0, max: 40 }), (from, len) => {
        const empty: Anchor = { status: 'attached', from, to: from };
        const r = { from: Math.max(0, from - len), to: from + len };
        expect(anchorAfterRemoval(empty, r).status).toBe('attached');
      }),
    );
  });

  it('grows the range for an insertion inside it', () => {
    expect(anchorAfterInsertion(attached, { at: 15, length: 3 })).toEqual({
      status: 'attached',
      from: 10,
      to: 23,
    });
  });
});

describe('write conflicts (UX-029 criterion 6, the rule part)', () => {
  it('shows the latest state and keeps the draft when If-Match fails', () => {
    const outcome = writeOutcome('my draft', {
      ok: false,
      code: PRECONDITION_FAILED,
      latest: { text: 'theirs' },
    });
    expect(outcome).toEqual({ kind: 'conflict', shown: { text: 'theirs' }, draft: 'my draft' });
  });

  it('reports a save with the latest state', () => {
    expect(writeOutcome('d', { ok: true, latest: 1 })).toEqual({ kind: 'saved', latest: 1 });
  });

  it('rethrows any other failure rather than deciding it', () => {
    expect(() => writeOutcome('d', { ok: false, code: 'forbidden' })).toThrow(/forbidden/);
  });
});

function threadInput(id: string, position: number, over: Partial<ThreadInput> = {}): ThreadInput {
  return {
    id,
    position,
    state: 'open',
    author: 'ann',
    createdAt: '2026-11-13T09:00:00Z',
    replyCount: 0,
    target: { range: { from: 1, to: 4, baseSeq: 9 } },
    excerpt: 'abc',
    blockKind: null,
    ...over,
  };
}

describe('the pane rows (UX-030 criterion 1, and the name of criterion 6)', () => {
  it('lists threads in document order with author, time, state, target and reply count', () => {
    const rows = paneRows([
      threadInput('late', 9, { replyCount: 2, state: 'resolved' }),
      threadInput('early', 1, {
        target: { block: 'fig-1' },
        excerpt: null,
        blockKind: 'figure',
        author: 'ben',
      }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(['early', 'late']);
    expect(rows[0]).toEqual({
      id: 'early',
      author: 'ben',
      createdAt: '2026-11-13T09:00:00Z',
      state: 'open',
      replyCount: 0,
      target: { kind: 'block', blockKind: 'figure' },
      accessibleName: { author: 'ben', state: 'open', replyCount: 0 },
    });
    expect(rows[1]?.target).toEqual({ kind: 'excerpt', text: 'abc' });
    expect(rows[1]?.accessibleName).toEqual({ author: 'ann', state: 'resolved', replyCount: 2 });
  });

  it('keeps every thread (none dropped) and sorts by position (property)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            position: fc.integer({ min: 0, max: 30 }),
            author: fc.constantFrom(...NAMES),
          }),
          { maxLength: 25 },
        ),
        (items) => {
          const threads = items.map((it, i) =>
            threadInput(`t${i}`, it.position, { author: it.author }),
          );
          const rows = paneRows(threads);
          expect(rows).toHaveLength(threads.length);
          const positions = rows.map((r) => threads.find((t) => t.id === r.id)!.position);
          expect([...positions].sort((a, b) => a - b)).toEqual(positions);
        },
      ),
    );
  });

  it('shows a thread whose text is gone as detached rather than dropping it', () => {
    const [row] = paneRows([threadInput('x', 0, { excerpt: null })]);
    expect(row?.target).toEqual({ kind: 'detached' });
  });
});

describe('assignment (UX-032 criteria 1 and 2, the rule part)', () => {
  it('sets the assignee and raises dep.task.assigned for a new assignment', () => {
    const result = assignThread({ id: 't', assignee: null }, 'ben', ['comment']);
    expect(result).toEqual({
      ok: true,
      thread: { id: 't', assignee: 'ben' },
      event: { type: 'dep.task.assigned', threadId: 't', assignee: 'ben' },
    });
  });

  it('reassigns and raises the event again for a different person', () => {
    const result = assignThread({ id: 't', assignee: 'ben' }, 'cy', ['comment']);
    expect(result.ok && result.event).toEqual({
      type: 'dep.task.assigned',
      threadId: 't',
      assignee: 'cy',
    });
  });

  it('clears the assignee without an event, since 05 section 7 names none (open)', () => {
    const result = assignThread({ id: 't', assignee: 'ben' }, null, ['comment']);
    expect(result).toEqual({ ok: true, thread: { id: 't', assignee: null }, event: null });
  });

  it('raises no event when the assignee is unchanged', () => {
    const result = assignThread({ id: 't', assignee: 'ben' }, 'ben', ['comment']);
    expect(result.ok && result.event).toBeNull();
  });

  it('refuses without comment in the thread scope, changing nothing (property)', () => {
    fc.assert(
      fc.property(capsArb, fc.constantFrom(...NAMES, null), (caps, who) => {
        const thread = { id: 't', assignee: 'ann' as string | null };
        const result = assignThread(thread, who, caps);
        if (caps.includes('comment')) {
          expect(result.ok).toBe(true);
        } else {
          expect(result).toEqual({ ok: false, reason: 'noComment' });
        }
        expect(thread.assignee).toBe('ann');
      }),
    );
  });
});

describe('links to a comment (UX-034 criteria 1 and 3)', () => {
  it('hands the host only the two identifiers (criterion 1)', () => {
    const request = commentLinkRequest('doc-1', 'c-9');
    expect(request).toEqual({ document: 'doc-1', comment: 'c-9' });
    expect(Object.keys(request ?? {}).sort()).toEqual(['comment', 'document']);
  });

  it('refuses an empty identifier', () => {
    expect(commentLinkRequest('', 'c')).toBeNull();
    expect(commentLinkRequest('d', '')).toBeNull();
  });

  it('opens a visible thread (criterion 2 input)', () => {
    const thread = {
      id: 'c-9',
      author: 'ann',
      createdAt: '2026-11-13T09:00:00Z',
      state: 'open' as const,
    };
    expect(resolveCommentLink({ status: 'visible', thread })).toEqual({ kind: 'open', thread });
  });

  it('gives the same bare outcome for a deleted comment and one the user cannot view (property)', () => {
    const deleted = resolveCommentLink({ status: 'deleted' });
    const forbidden = resolveCommentLink({ status: 'forbidden' });
    expect(deleted).toEqual({ kind: 'unavailable' });
    expect(forbidden).toEqual(deleted);
    fc.assert(
      fc.property(
        fc.constantFrom('deleted', 'forbidden') as fc.Arbitrary<'deleted' | 'forbidden'>,
        (status) => {
          const outcome = resolveCommentLink({ status });
          expect(Object.keys(outcome)).toEqual(['kind']);
        },
      ),
    );
  });
});
