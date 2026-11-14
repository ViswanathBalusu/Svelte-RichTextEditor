// Suggestion decisions in history (08 §14; HIS-042): the index from suggestion identifier to the
// commit that introduced it, the date taken from the log rather than the mark, and the history list
// labelling accepted and rejected suggestions with the deciding user.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { CommitMeta } from '../src/types.ts';
import { listHistory } from '../src/groups.ts';
import { introducedBy, suggestionDate, suggestionIndex } from '../src/suggestions.ts';

const T0 = Date.UTC(2026, 10, 6, 9, 0, 0);
const MIN = 60_000;

function commit(seq: number, time: number, user: string, origin: string): CommitMeta {
  return { seq, kind: 'steps', user, session: `s-${user}`, time, origin, scopes: ['region:r1'] };
}

describe('the index from suggestion to introducing commit (HIS-042 criterion 4)', () => {
  it('answers from the index without reading the log', () => {
    const r = suggestionIndex([
      { suggestionId: 'sg-1', seq: 4 },
      { suggestionId: 'sg-2', seq: 9 },
    ]);
    if (!r.ok) throw new Error(r.reason);
    expect(introducedBy(r.index, 'sg-2')).toBe(9);
    expect(introducedBy(r.index, 'sg-missing')).toBeUndefined();
  });

  it('keeps the lowest seq for an identifier, whatever the order of the entries (property)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            suggestionId: fc.constantFrom('sg-a', 'sg-b', 'sg-c'),
            seq: fc.integer({ min: 1, max: 50 }),
          }),
          { maxLength: 30 },
        ),
        (entries) => {
          const r = suggestionIndex(entries);
          if (!r.ok) throw new Error(r.reason);
          for (const id of ['sg-a', 'sg-b', 'sg-c']) {
            const seqs = entries.filter((e) => e.suggestionId === id).map((e) => e.seq);
            if (seqs.length === 0) expect(introducedBy(r.index, id)).toBeUndefined();
            else expect(introducedBy(r.index, id)).toBe(Math.min(...seqs));
          }
        },
      ),
    );
  });

  it('refuses an empty identifier and a seq that is not a positive whole number', () => {
    expect(suggestionIndex([{ suggestionId: '', seq: 1 }])).toMatchObject({
      ok: false,
      code: 'validation_failed',
    });
    expect(suggestionIndex([{ suggestionId: 'sg-1', seq: 0 }])).toMatchObject({
      ok: false,
      code: 'validation_failed',
    });
    expect(suggestionIndex([{ suggestionId: 'sg-1', seq: 1.5 }])).toMatchObject({
      ok: false,
      code: 'validation_failed',
    });
  });
});

describe('the date of a suggestion comes from the log (HIS-042 criterion 2)', () => {
  it('gives the server time of the introducing commit, found by the identifier', () => {
    const commits = [
      commit(1, T0, 'alice', 'input'),
      commit(2, T0 + 7 * MIN, 'bob', 'suggestion.insert'),
    ];
    const at = (seq: number) => commits.find((c) => c.seq === seq);
    const idx = suggestionIndex([{ suggestionId: 'sg-7', seq: 2 }]);
    if (!idx.ok) throw new Error(idx.reason);
    const r = suggestionDate(idx.index, 'sg-7', at);
    if (!r.ok) throw new Error(r.reason);
    expect(r.date).toEqual({
      suggestionId: 'sg-7',
      seq: 2,
      time: T0 + 7 * MIN,
      origin: 'suggestion.insert',
      user: 'bob',
    });
  });

  it('is not_found for an identifier the index does not hold, or a commit the log lacks', () => {
    const idx = suggestionIndex([{ suggestionId: 'sg-7', seq: 2 }]);
    if (!idx.ok) throw new Error(idx.reason);
    expect(suggestionDate(idx.index, 'sg-none', () => undefined)).toMatchObject({
      ok: false,
      code: 'not_found',
    });
    expect(suggestionDate(idx.index, 'sg-7', () => undefined)).toMatchObject({
      ok: false,
      code: 'not_found',
    });
  });
});

describe('accepted and rejected suggestions in the history list (HIS-042 criterion 1, list part)', () => {
  it('shows each decision with its origin label and the deciding user', () => {
    const commits = [
      commit(1, T0, 'alice', 'input'),
      commit(2, T0 + 10 * MIN, 'alice', 'suggestion.accept'),
      commit(3, T0 + 20 * MIN, 'bob', 'suggestion.reject'),
    ];
    const r = listHistory({
      commits,
      versions: [],
      gate: { min: 0, head: 3 },
      options: { idleGapMs: 60_000 },
    });
    if (!r.ok) throw new Error(r.reason);
    const groups = r.items.flatMap((i) => (i.type === 'group' ? [i] : []));
    expect(
      groups.map((g) => ({ origins: g.origins, authors: g.authors.map((a) => a.user) })),
    ).toEqual([
      { origins: ['suggestion.reject'], authors: ['bob'] },
      { origins: ['suggestion.accept'], authors: ['alice'] },
      { origins: ['input'], authors: ['alice'] },
    ]);
  });
});
