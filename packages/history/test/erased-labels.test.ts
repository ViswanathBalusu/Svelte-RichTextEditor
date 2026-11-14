// The history list shows an erased person as an unknown author, and no erased surrogate appears in
// the labelled list (08 §13; HIS-038 criterion 2, list part).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { labelHistoryItems } from '../src/erased-labels.ts';
import { type CommitMeta, groupCommits, listHistory } from '../src/groups.ts';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 6, 9, 0, 0);

function commit(seq: number, minutes: number, user: string, agent?: string): CommitMeta {
  return {
    seq,
    kind: 'steps',
    user,
    session: `s-${user}`,
    time: T0 + minutes * MIN,
    origin: 'input',
    scopes: ['body'],
    ...(agent !== undefined ? { agent } : {}),
  };
}

describe('the history list after an erasure (HIS-038 criterion 2, list part)', () => {
  it('shows an erased surrogate as an unknown person and keeps the other authors', () => {
    const commits = [
      commit(1, 0, 'u-7f3a'),
      commit(2, 1, 'u-1'),
      commit(3, 2, 'u-7f3a', 'agent-7'),
    ];
    const groups = groupCommits(commits, []);
    const labelled = labelHistoryItems(groups, new Set(['u-7f3a']));
    const authors = labelled.flatMap((g) => (g.type === 'group' ? g.authors : []));
    expect(authors).toContainEqual({ kind: 'person', user: 'u-1' });
    expect(authors.filter((a) => a.kind === 'unknown')).not.toHaveLength(0);
    for (const a of authors) if (a.kind === 'unknown') expect(a).not.toHaveProperty('user');
  });

  it('keeps an assistant named on an erased person’s run, without naming the person', () => {
    const groups = groupCommits([commit(1, 0, 'u-7f3a', 'agent-7')], []);
    const [g] = labelHistoryItems(groups, new Set(['u-7f3a']));
    expect(g).toMatchObject({ type: 'group', authors: [{ kind: 'unknown', agent: 'agent-7' }] });
  });

  it('never shows an erased identifier in the labelled list, for any mix of authors (property)', () => {
    const users = ['u-7f3a', 'u-1', 'u-2', 'u-3'];
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ user: fc.constantFrom(...users), gap: fc.integer({ min: 0, max: 12 }) }),
          {
            minLength: 1,
            maxLength: 30,
          },
        ),
        fc.subarray(users),
        (rows, erasedList) => {
          const erased = new Set(erasedList);
          let minutes = 0;
          const commits = rows.map((r, i) => {
            minutes += r.gap;
            return commit(i + 1, minutes, r.user);
          });
          const groups = groupCommits(commits, []);
          const labelled = labelHistoryItems(groups, erased);
          const json = JSON.stringify(labelled);
          for (const id of erased) expect(json).not.toContain(`"${id}"`);
          for (const g of labelled) {
            if (g.type !== 'group') continue;
            for (const a of g.authors) {
              if (a.kind === 'unknown') continue;
              expect(erased.has(a.user)).toBe(false);
            }
          }
        },
      ),
    );
  });

  it('labels the groups of a listed page the same way, and leaves versions as they are', () => {
    const r = listHistory({
      commits: [commit(1, 0, 'u-7f3a'), commit(2, 1, 'u-1')],
      versions: [],
      gate: { min: 0, head: 2 },
    });
    if (!r.ok) throw new Error('the list was refused');
    const items = labelHistoryItems(r.items, new Set(['u-7f3a']));
    expect(items.some((i) => i.type === 'group')).toBe(true);
    expect(JSON.stringify(items)).not.toContain('"u-7f3a"');
  });
});
