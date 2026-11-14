/**
 * The comment rules (UX-029 criteria 2 and 5; UX-030 criterion 3; 07 §12). Pure functions over the
 * capabilities the core reports for a scope: the controls that call them are not built yet.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Capability } from '../src/core-api.ts';
import {
  DEFAULT_THREAD_FILTER,
  canDeleteComment,
  canDeleteThread,
  canEditComment,
  canReply,
  filterThreads,
  type ThreadRow,
} from '../src/shell/comment-rules.ts';

const CAPS: readonly Capability[] = [
  'view',
  'comment',
  'suggest',
  'edit',
  'fill',
  'structure',
  'manage',
];
const USERS = ['ann', 'ben', 'cy', 'dee'] as const;

describe('edit and delete of comments and threads (UX-029 criterion 2)', () => {
  it('lets the author edit and delete their own comment, with no other capability', () => {
    expect(canEditComment('ann', 'ann', ['comment']).allowed).toBe(true);
    expect(canDeleteComment('ann', 'ann', ['comment']).allowed).toBe(true);
    expect(canDeleteThread('ann', 'ann', ['comment']).allowed).toBe(true);
  });

  it('refuses another person without manage, with the reason', () => {
    expect(canEditComment('ben', 'ann', ['comment', 'edit', 'suggest'])).toEqual({
      allowed: false,
      reason: 'notAuthor',
    });
    expect(canDeleteComment('ben', 'ann', ['comment', 'edit'])).toEqual({
      allowed: false,
      reason: 'notAuthor',
    });
    expect(canDeleteThread('ben', 'ann', ['comment'])).toEqual({
      allowed: false,
      reason: 'notAuthor',
    });
  });

  it('lets a user with manage act on any comment or thread (property)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...USERS),
        fc.constantFrom(...USERS),
        fc.subarray([...CAPS]),
        (user, author, caps) => {
          const withManage = [
            ...caps.filter((c) => c !== 'manage'),
            'manage',
          ] as readonly Capability[];
          expect(canEditComment(user, author, withManage).allowed).toBe(true);
          expect(canDeleteComment(user, author, withManage).allowed).toBe(true);
          expect(canDeleteThread(user, author, withManage).allowed).toBe(true);
        },
      ),
    );
  });

  it('allows only the author or a manager, and nobody else (property)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...USERS),
        fc.constantFrom(...USERS),
        fc.subarray([...CAPS]),
        (user, author, caps) => {
          const withoutManage = caps.filter((c) => c !== 'manage');
          const expected = user === author;
          expect(canEditComment(user, author, withoutManage).allowed).toBe(expected);
          expect(canDeleteComment(user, author, withoutManage).allowed).toBe(expected);
          expect(canDeleteThread(user, author, withoutManage).allowed).toBe(expected);
        },
      ),
    );
  });
});

describe('reply box with and without comment (UX-029 criterion 5)', () => {
  it('withdraws the reply box, with a reason, when comment is missing in the scope', () => {
    expect(canReply(['view', 'suggest', 'edit'])).toEqual({ allowed: false, reason: 'noComment' });
    expect(canReply([])).toEqual({ allowed: false, reason: 'noComment' });
  });

  it('allows a reply exactly when comment is held (property)', () => {
    fc.assert(
      fc.property(fc.subarray([...CAPS]), (caps) => {
        expect(canReply(caps).allowed).toBe(caps.includes('comment'));
      }),
    );
  });
});

describe('the thread filters (UX-030 criterion 3; UX-029 criterion 3)', () => {
  const threads: ThreadRow[] = [
    { id: 't3', state: 'open', assignee: 'ben', position: 30 },
    { id: 't1', state: 'resolved', assignee: null, position: 10 },
    { id: 't2', state: 'open', assignee: 'ann', position: 20 },
    { id: 't4', state: 'resolved', assignee: 'ben', position: 40 },
  ];

  it('lists open threads by default, in document order, and leaves resolved ones out', () => {
    expect(filterThreads(threads, DEFAULT_THREAD_FILTER).map((t) => t.id)).toEqual(['t2', 't3']);
  });

  it('lists resolved threads only through the resolved filter', () => {
    expect(filterThreads(threads, { state: 'resolved' }).map((t) => t.id)).toEqual(['t1', 't4']);
  });

  it('lists every thread with the all filter', () => {
    expect(filterThreads(threads, { state: 'all' }).map((t) => t.id)).toEqual([
      't1',
      't2',
      't3',
      't4',
    ]);
  });

  it('narrows to the threads assigned to one person', () => {
    expect(filterThreads(threads, { state: 'all', assignee: 'ben' }).map((t) => t.id)).toEqual([
      't3',
      't4',
    ]);
    expect(filterThreads(threads, { state: 'open', assignee: 'ben' }).map((t) => t.id)).toEqual([
      't3',
    ]);
  });

  it('lists only threads that match the state and the assignee (property)', () => {
    const rowArb = fc.record({
      id: fc.uuid(),
      state: fc.constantFrom('open' as const, 'resolved' as const),
      assignee: fc.option(fc.constantFrom(...USERS), { nil: null }),
      position: fc.integer({ min: 0, max: 1000 }),
    });
    fc.assert(
      fc.property(
        fc.array(rowArb, { maxLength: 30 }),
        fc.constantFrom('open' as const, 'resolved' as const, 'all' as const),
        fc.option(fc.constantFrom(...USERS), { nil: null }),
        (rows, state, assignee) => {
          const listed = filterThreads(rows, { state, assignee });
          for (const t of listed) {
            if (state !== 'all') expect(t.state).toBe(state);
            if (assignee !== null) expect(t.assignee).toBe(assignee);
          }
          const expected = rows.filter(
            (t) =>
              (state === 'all' || t.state === state) &&
              (assignee === null || t.assignee === assignee),
          );
          expect(listed.length).toBe(expected.length);
          for (let i = 1; i < listed.length; i++) {
            expect(listed[i - 1]!.position).toBeLessThanOrEqual(listed[i]!.position);
          }
        },
      ),
    );
  });
});
