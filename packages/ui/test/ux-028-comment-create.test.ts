/**
 * The comment thread creation controller (UX-028 criteria 2, 3 and 5 at controller level). No core
 * request, no `thread.created` event, no rendered pane and no highlight is tested here.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Capability } from '../src/core-api.ts';
import {
  commentCommandDecision,
  createCommentThread,
  refuseFromServer,
} from '../src/shell/comment-create.ts';
import { THREAD_LIMIT } from '../src/shell/thread-target.ts';

const WITH_COMMENT: readonly Capability[] = ['view', 'comment'];
const VIEW_ONLY: readonly Capability[] = ['view'];

describe('a block selection creates a thread that targets { block: id } (UX-028 criterion 2)', () => {
  it('targets a figure, table or equation by identifier, with the first comment kept', () => {
    const result = createCommentThread({
      selection: { kind: 'block', id: 'fig-3' },
      scopes: [WITH_COMMENT],
      threadCount: 0,
      draft: 'Check the axis labels.',
    });
    expect(result).toEqual({
      ok: true,
      target: { block: 'fig-3' },
      body: 'Check the axis labels.',
    });
  });

  it('targets a text range with its baseSeq and never adds a block key beside it', () => {
    const result = createCommentThread({
      selection: { kind: 'range', from: 2, to: 8, baseSeq: 17 },
      scopes: [WITH_COMMENT],
      threadCount: 4,
      draft: 'Rephrase this.',
    });
    expect(result).toMatchObject({ ok: true, target: { range: { from: 2, to: 8, baseSeq: 17 } } });
    if (result.ok) expect('block' in result.target).toBe(false);
  });

  it('a block selection with an empty identifier is refused and the draft is kept', () => {
    const result = createCommentThread({
      selection: { kind: 'block', id: '' },
      scopes: [WITH_COMMENT],
      threadCount: 0,
      draft: 'x',
    });
    expect(result).toEqual({ ok: false, reason: 'emptyBlock', draft: 'x' });
  });
});

describe('the command is disabled with a reason without comment in a covered scope (UX-028 criterion 3)', () => {
  it('is offered only when every covered scope grants comment', () => {
    expect(commentCommandDecision([WITH_COMMENT, WITH_COMMENT])).toEqual({ allowed: true });
    expect(commentCommandDecision([WITH_COMMENT, VIEW_ONLY])).toEqual({
      allowed: false,
      reason: 'noComment',
    });
    expect(commentCommandDecision([])).toEqual({ allowed: false, reason: 'noComment' });
  });

  it('refuses a creation in a scope without comment and keeps the typed text (property)', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 40 }),
        fc.array(fc.constantFrom<Capability>('view', 'suggest', 'edit', 'manage'), {
          maxLength: 4,
        }),
        (draft, caps) => {
          const result = createCommentThread({
            selection: { kind: 'block', id: 'b1' },
            scopes: [VIEW_ONLY, caps],
            threadCount: 0,
            draft,
          });
          expect(result).toEqual({ ok: false, reason: 'noComment', draft });
        },
      ),
    );
  });

  it('a server refusal keeps the typed text and gives the reason', () => {
    expect(refuseFromServer('keep me', 'permissionsChanged')).toEqual({
      ok: false,
      reason: 'permissionsChanged',
      draft: 'keep me',
    });
    expect(refuseFromServer('keep me', 'baseSeqOutOfWindow')).toEqual({
      ok: false,
      reason: 'baseSeqOutOfWindow',
      draft: 'keep me',
    });
  });
});

describe('the thread limit refuses a creation and keeps the draft (UX-028 criterion 5, the controller part)', () => {
  it('refuses at 5,000 threads with the code threadLimit, creates nothing and keeps the draft', () => {
    const result = createCommentThread({
      selection: { kind: 'range', from: 0, to: 1, baseSeq: 0 },
      scopes: [WITH_COMMENT],
      threadCount: THREAD_LIMIT,
      draft: 'one more',
    });
    expect(result).toEqual({ ok: false, reason: 'threadLimit', draft: 'one more' });
  });

  it('accepts any count below the limit (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: THREAD_LIMIT - 1 }), (threadCount) => {
        const result = createCommentThread({
          selection: { kind: 'block', id: 'b' },
          scopes: [WITH_COMMENT],
          threadCount,
          draft: 'ok',
        });
        expect(result.ok).toBe(true);
      }),
    );
  });
});

describe('an empty first comment is refused', () => {
  it('keeps the whitespace-only draft and gives emptyBody', () => {
    const result = createCommentThread({
      selection: { kind: 'block', id: 'b' },
      scopes: [WITH_COMMENT],
      threadCount: 0,
      draft: '   ',
    });
    expect(result).toEqual({ ok: false, reason: 'emptyBody', draft: '   ' });
  });
});
