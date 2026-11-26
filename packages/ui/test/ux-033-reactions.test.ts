/**
 * The reaction buttons of a comment (UX-033): one state for each of the six reactions, in the same
 * places, with the count, whether the user holds it, and the names of the people behind it.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ReactionView } from '../src/core-api.ts';
import { REACTIONS, reactionPeople, reactionStates } from '../src/shell/reactions.ts';

describe('reaction states', () => {
  it('has the six reactions in order, held or not', () => {
    const states = reactionStates(undefined, 'user:a');
    expect(states.map((s) => s.reaction)).toEqual([...REACTIONS]);
    expect(states.every((s) => s.count === 0 && !s.mine)).toBe(true);
  });

  it('counts the people and marks the reaction the user holds', () => {
    const view: ReactionView[] = [
      { reaction: 'heart', users: ['user:a', 'user:b'] },
      { reaction: 'done', users: ['user:b'] },
    ];
    const states = reactionStates(view, 'user:a');
    expect(states.find((s) => s.reaction === 'heart')).toMatchObject({ count: 2, mine: true });
    expect(states.find((s) => s.reaction === 'done')).toMatchObject({ count: 1, mine: false });
    expect(states.find((s) => s.reaction === 'eyes')).toMatchObject({ count: 0, mine: false });
  });

  it('never marks a reaction as mine when the user is not known', () => {
    const view: ReactionView[] = [{ reaction: 'heart', users: ['user:a'] }];
    expect(reactionStates(view, '').some((s) => s.mine)).toBe(false);
  });

  it('names the people in the order they reacted, and nobody for an empty reaction', () => {
    const view: ReactionView[] = [{ reaction: 'laugh', users: ['user:b', 'user:a'] }];
    const [laugh, heart] = [
      reactionStates(view, 'user:a').find((s) => s.reaction === 'laugh')!,
      reactionStates(view, 'user:a').find((s) => s.reaction === 'heart')!,
    ];
    expect(reactionPeople(laugh, (p) => p.slice(5).toUpperCase())).toBe('B, A');
    expect(reactionPeople(heart, (p) => p)).toBeNull();
  });

  it('is in step with the list the protocol defines (property over generated views)', () => {
    fc.assert(
      fc.property(
        fc.subarray([...REACTIONS], { minLength: 0 }),
        fc.array(fc.constantFrom('user:a', 'user:b', 'user:c'), { minLength: 1, maxLength: 3 }),
        (held, users) => {
          const view: ReactionView[] = held.map((reaction) => ({ reaction, users }));
          const states = reactionStates(view, 'user:a');
          expect(states.map((s) => s.reaction)).toEqual([...REACTIONS]);
          for (const s of states)
            expect(s.count).toBe(held.includes(s.reaction) ? users.length : 0);
        },
      ),
    );
  });
});
