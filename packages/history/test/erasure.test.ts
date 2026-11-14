// How an erased person is shown (08 §13; HIS-038 criterion 2; HIS-015 criterion 5): the surrogate
// of an erased person is shown as an unknown person, never as a name; other people are unchanged;
// an assistant named on a run stays named.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { shownAuthor } from '../src/erasure.ts';

describe('the label of an erased person (HIS-015 criterion 5)', () => {
  it('shows an erased surrogate as an unknown person', () => {
    expect(shownAuthor({ user: 'u-7f3a' }, new Set(['u-7f3a']))).toEqual({ kind: 'unknown' });
  });

  it('keeps the label of a person who was not erased', () => {
    expect(shownAuthor({ user: 'u-1' }, new Set(['u-7f3a']))).toEqual({
      kind: 'person',
      user: 'u-1',
    });
  });

  it("still names the assistant on an erased person's run, since the agent is not the person", () => {
    expect(shownAuthor({ user: 'u-7f3a', agent: 'agent-7' }, new Set(['u-7f3a']))).toEqual({
      kind: 'unknown',
      agent: 'agent-7',
    });
  });

  it('never shows an erased identifier as a person, whatever else is erased (property)', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 6 }),
        fc.string({ minLength: 1, maxLength: 8 }),
        (erased, user) => {
          const set = new Set(erased);
          const shown = shownAuthor({ user }, set);
          if (set.has(user)) expect(shown.kind).toBe('unknown');
          else expect(shown).toEqual({ kind: 'person', user });
        },
      ),
    );
  });
});
