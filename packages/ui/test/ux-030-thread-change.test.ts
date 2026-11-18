/**
 * What a refresh of the comments list changed (UX-030 criterion 4, the announcement): the rule
 * `describeThreadChange` picks one change to announce, from the list the pane showed and the list
 * it reads now.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { describeThreadChange, type ChangeInput } from '../src/shell/comment-threads.ts';

const t = (id: string, over: Partial<ChangeInput> = {}): ChangeInput => ({
  id,
  state: 'open',
  author: `author-${id}`,
  replyCount: 0,
  ...over,
});

describe('describeThreadChange', () => {
  it('says nothing when nothing changed', () => {
    expect(describeThreadChange([t('a'), t('b')], [t('a'), t('b')])).toBeNull();
    expect(describeThreadChange([], [])).toBeNull();
  });

  it('names a new thread, a reply, a resolve, a reopen and a delete', () => {
    expect(describeThreadChange([t('a')], [t('a'), t('b')])).toEqual({
      kind: 'created',
      author: 'author-b',
    });
    expect(describeThreadChange([t('a')], [t('a', { replyCount: 1 })])).toEqual({
      kind: 'reply',
      author: 'author-a',
    });
    expect(describeThreadChange([t('a')], [t('a', { state: 'resolved' })])).toEqual({
      kind: 'resolved',
      author: 'author-a',
    });
    expect(describeThreadChange([t('a', { state: 'resolved' })], [t('a')])).toEqual({
      kind: 'reopened',
      author: 'author-a',
    });
    expect(describeThreadChange([t('a'), t('b')], [t('a')])).toEqual({
      kind: 'deleted',
      author: 'author-b',
    });
  });

  it('prefers a new thread over a reply, a reply over a state change, and that over a delete', () => {
    const before = [t('a'), t('b'), t('c')];
    expect(
      describeThreadChange(before, [
        t('a', { replyCount: 2 }),
        t('b', { state: 'resolved' }),
        t('d'),
      ])?.kind,
    ).toBe('created');
    expect(
      describeThreadChange(before, [t('a', { replyCount: 2 }), t('b', { state: 'resolved' })])
        ?.kind,
    ).toBe('reply');
    expect(describeThreadChange(before, [t('a'), t('b', { state: 'resolved' })])?.kind).toBe(
      'resolved',
    );
  });

  it('is silent exactly when the lists agree on ids, states and reply counts (property)', () => {
    const thread = fc.record({
      id: fc.constantFrom('a', 'b', 'c', 'd'),
      state: fc.constantFrom<'open' | 'resolved'>('open', 'resolved'),
      author: fc.constantFrom('x', 'y'),
      replyCount: fc.integer({ min: 0, max: 3 }),
    });
    const list = fc.uniqueArray(thread, { selector: (x) => x.id, maxLength: 4 });
    fc.assert(
      fc.property(list, list, (before, after) => {
        const b = new Map(before.map((x) => [x.id, x]));
        const same =
          before.length === after.length &&
          after.every((x) => {
            const old = b.get(x.id);
            return old !== undefined && old.state === x.state && old.replyCount === x.replyCount;
          });
        const change = describeThreadChange(before, after);
        const shrunkReplies = after.some((x) => {
          const old = b.get(x.id);
          return old !== undefined && old.replyCount > x.replyCount;
        });
        // A change is reported unless the only difference is a reply count that went down.
        if (same) expect(change).toBeNull();
        else if (change === null) {
          expect(
            shrunkReplies && before.length === after.length && after.every((x) => b.has(x.id)),
          ).toBe(true);
        }
      }),
    );
  });
});
