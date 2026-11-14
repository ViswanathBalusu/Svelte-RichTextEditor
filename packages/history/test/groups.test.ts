// The history list (08 §4; 05 §6.1, §6.2; HIS-008): groups computed when the list is read, the
// filters, pages with an opaque cursor, what each group shows, and the visibility gate.
import { NOTHING_HIDDEN } from '@docedit/authority';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_IDLE_GAP_MS,
  type HistoryGroup,
  type HistoryItem,
  byDay,
  dayOf,
  groupCommits,
  listHistory,
} from '../src/groups.ts';
import type { CommitMeta, StoredVersion } from '../src/types.ts';
import { HIDDEN } from './fixtures.ts';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 6, 9, 0, 0);

function c(
  seq: number,
  minutes: number,
  user = 'alice',
  extra: Partial<CommitMeta> = {},
): CommitMeta {
  return {
    seq,
    kind: 'steps',
    user,
    session: `s-${user}`,
    time: T0 + minutes * MIN,
    origin: 'input',
    scopes: ['body'],
    ...extra,
  };
}

const version = (
  seq: number,
  kind: StoredVersion['kind'] = 'named',
  name = `v${seq}`,
): StoredVersion => ({
  seq,
  kind,
  name,
  createdBy: 'alice',
  createdAt: T0 + seq * MIN,
});

const spans = (gs: readonly HistoryGroup[]) => gs.map((g) => [g.fromSeq, g.toSeq]);

describe('history groups (HIS-008)', () => {
  it('starts a group after an idle gap, when the authors change, at a change of origin and after a version', () => {
    const commits = [
      c(1, 0),
      c(2, 1),
      c(3, 9), // idle gap of eight minutes
      c(4, 10, 'bob'), // bob joins: the authors change
      c(5, 11),
      c(6, 12, 'bob'),
      c(7, 13, 'alice', { origin: 'paste' }), // ordinary editing: no new group
      c(8, 14, 'alice', { origin: 'restore', session: 'system' }), // a restore
      c(9, 15),
      c(10, 16),
      c(11, 17),
    ];
    const groups = groupCommits(commits, [version(9)]);
    expect(spans(groups)).toEqual([
      [1, 2],
      [3, 3],
      [4, 7],
      [8, 8],
      [9, 9],
      [10, 11],
    ]);
    expect(groups[2]!.authors).toEqual([{ user: 'bob' }, { user: 'alice' }]);
    expect(groups[3]!.origins).toEqual(['restore']);
    expect(groups[3]!.sessions).toEqual([]);
    expect(groups[4]!.versions.map((v) => v.seq)).toEqual([9]);
  });

  it('ends a group when someone stops writing for longer than the idle gap', () => {
    const groups = groupCommits([c(1, 0), c(2, 1, 'bob'), c(3, 2), c(4, 5), c(5, 7), c(6, 8)], []);
    // Bob's last commit is at minute 1; at minute 7 he has been away for six minutes.
    expect(spans(groups)).toEqual([
      [1, 1],
      [2, 4],
      [5, 6],
    ]);
  });

  it('changes with the idle gap in configuration, with nothing stored', () => {
    const commits = [c(1, 0), c(2, 3), c(3, 6), c(4, 9)];
    expect(spans(groupCommits(commits, []))).toEqual([[1, 4]]);
    expect(spans(groupCommits(commits, [], { idleGapMs: 2 * MIN }))).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
    ]);
    expect(DEFAULT_IDLE_GAP_MS).toBe(5 * MIN);
  });

  it('splits at midnight in the time zone asked for', () => {
    const late = Date.UTC(2026, 10, 6, 22, 58);
    const commits = [
      { ...c(1, 0), time: late },
      { ...c(2, 0), time: late + 3 * MIN },
    ];
    expect(spans(groupCommits(commits, [], { timeZone: 'UTC' }))).toEqual([[1, 2]]);
    // In Berlin (UTC+1 in November) the second commit is on the next day.
    expect(spans(groupCommits(commits, [], { timeZone: 'Europe/Berlin' }))).toEqual([
      [1, 1],
      [2, 2],
    ]);
    expect(dayOf(late, 'Europe/Berlin')).toBe('2026-11-06');
    expect(dayOf(late + 3 * MIN, 'Europe/Berlin')).toBe('2026-11-07');
  });

  it('shows the day, the sessions, the authors with their agents, the time range, the count and the origins', () => {
    const [g] = groupCommits(
      [c(1, 0, 'bob'), c(2, 1, 'bob', { agent: 'agent-7', origin: 'assistant', session: 's-bob' })],
      [],
      {},
    );
    // An assistant acting for bob is an author of its own, so a new group starts.
    const groups = groupCommits([c(1, 0, 'bob'), c(2, 1, 'bob'), c(3, 2, 'carol')], []);
    expect(g).toMatchObject({
      day: '2026-11-06',
      fromSeq: 1,
      toSeq: 1,
      changes: 1,
      authors: [{ user: 'bob' }],
      sessions: ['s-bob'],
      origins: ['input'],
    });
    expect(groups[1]).toMatchObject({
      type: 'group',
      day: '2026-11-06',
      fromSeq: 3,
      toSeq: 3,
      fromTime: T0 + 2 * MIN,
      toTime: T0 + 2 * MIN,
      changes: 1,
    });
    const assisted = groupCommits(
      [
        c(1, 0, 'bob', { agent: 'agent-7', origin: 'assistant' }),
        c(2, 1, 'bob', { agent: 'agent-7', origin: 'assistant' }),
      ],
      [],
    );
    expect(assisted).toHaveLength(1);
    expect(assisted[0]!.authors).toEqual([{ user: 'bob', agent: 'agent-7' }]);
  });

  it('leaves control commits out unless asked for', () => {
    const commits = [
      c(1, 0),
      c(2, 1, 'system', { kind: 'control', origin: 'control', session: 'system' }),
      c(3, 2),
    ];
    expect(groupCommits(commits, []).map((g) => g.changes)).toEqual([2]);
    expect(groupCommits(commits, [], { includeControl: true }).length).toBe(3);
  });
});

describe('the history list (HIS-008)', () => {
  const commits = [
    c(1, 0, 'alice', { scopes: ['body'] }),
    c(2, 1, 'alice', { scopes: ['region:rTerms000000000A'] }),
    c(3, 20, 'bob', { scopes: ['field:fTenantName00001'] }),
    c(4, 21, 'bob', { scopes: ['region:rTerms000000000A', 'body'] }),
    c(5, 50, 'carol', { scopes: ['region:rSecret00000000B'] }),
    c(6, 51, 'carol', { scopes: ['body'] }),
  ];
  const versions = [version(2), version(4, 'export'), version(6)];
  const all = { min: 0, head: 6 };

  const seqs = (items: readonly HistoryItem[]) =>
    items.map((i) => (i.type === 'group' ? `g${i.fromSeq}-${i.toSeq}` : `v${i.version.seq}`));

  it('applies each filter alone and together', () => {
    const list = (filter: object) => {
      const r = listHistory({ commits, versions, gate: all, filter });
      if (!r.ok) throw new Error(r.reason);
      return seqs(r.items);
    };
    expect(list({})).toEqual(['g5-6', 'g3-4', 'g1-2']);
    expect(list({ region: 'rTerms000000000A' })).toEqual(['g4-4', 'g2-2']);
    expect(list({ field: 'fTenantName00001' })).toEqual(['g3-3']);
    expect(list({ user: 'bob' })).toEqual(['g3-4']);
    expect(list({ fromSeq: 2, toSeq: 4 })).toEqual(['g3-4', 'g2-2']);
    expect(list({ user: 'alice', region: 'rTerms000000000A' })).toEqual(['g2-2']);
    expect(list({ namedOnly: true })).toEqual(['v6', 'v2']);
    expect(list({ namedOnly: true, fromSeq: 3 })).toEqual(['v6']);
    // Named versions after which the region changed since the previous named version.
    expect(list({ namedOnly: true, region: 'rTerms000000000A' })).toEqual(['v6', 'v2']);
    expect(list({ namedOnly: true, field: 'fTenantName00001' })).toEqual(['v6']);
  });

  it('pages newest first with an opaque cursor and a limit of at most 200', () => {
    const many = Array.from({ length: 30 }, (_, i) => c(i + 1, i * 10, i % 2 ? 'bob' : 'alice'));
    const pages: string[][] = [];
    let cursor: string | null = null;
    do {
      const r = listHistory({
        commits: many,
        versions: [],
        gate: { min: 0, head: 30 },
        limit: 7,
        cursor,
      });
      if (!r.ok) throw new Error(r.reason);
      pages.push(seqs(r.items));
      cursor = r.nextCursor;
    } while (cursor);
    expect(pages.map((p) => p.length)).toEqual([7, 7, 7, 7, 2]);
    expect(pages.flat()).toEqual(Array.from({ length: 30 }, (_, i) => `g${30 - i}-${30 - i}`));
    expect(listHistory({ commits: many, versions: [], gate: all, limit: 201 })).toMatchObject({
      ok: false,
      code: 'validation_failed',
    });
    expect(listHistory({ commits: many, versions: [], gate: all, cursor: '42' })).toMatchObject({
      ok: false,
      code: 'validation_failed',
    });
  });

  it('gives every item once across pages, whatever the limit (property)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ gap: fc.integer({ min: 0, max: 12 }), user: fc.constantFrom('a', 'b', 'c') }),
          { minLength: 1, maxLength: 60 },
        ),
        fc.integer({ min: 1, max: 12 }),
        (steps, limit) => {
          let t = 0;
          const cs = steps.map((s, i) => {
            t += s.gap;
            return c(i + 1, t, s.user);
          });
          const whole = listHistory({
            commits: cs,
            versions: [],
            gate: { min: 0, head: cs.length },
            limit: 200,
          });
          const seen: HistoryItem[] = [];
          let cursor: string | null = null;
          do {
            const r = listHistory({
              commits: cs,
              versions: [],
              gate: { min: 0, head: cs.length },
              limit,
              cursor,
            });
            if (!r.ok) throw new Error(r.reason);
            seen.push(...r.items);
            cursor = r.nextCursor;
          } while (cursor);
          expect(whole.ok && seen).toEqual(whole.ok && whole.items);
          // Every commit is in exactly one group.
          const covered = seen.flatMap((g) => (g.type === 'group' ? [g.fromSeq, g.toSeq] : []));
          expect(Math.min(...covered)).toBe(1);
        },
      ),
      { numRuns: 60, seed: 8 },
    );
  });

  it('obeys the gate: commits after it, and named versions only for a reader who sees named versions only', () => {
    const viewer = listHistory({
      commits,
      versions,
      gate: { min: 6, head: 6, named: (s) => s === 2 || s === 6 },
    });
    expect(viewer.ok && seqs(viewer.items)).toEqual(['v6', 'v2']);
    const since = listHistory({
      commits,
      versions,
      gate: { min: 3, head: 6, named: (s) => s === 2 || s === 6 },
    });
    // From the state at seq 3: commits 4 to 6; the export version at 4 is visible, and the named
    // one at 2 is listed on its own.
    expect(since.ok && seqs(since.items)).toEqual(['g5-6', 'g4-4', 'v2']);
    expect(
      since.ok &&
        since.items.flatMap((i) => (i.type === 'group' ? i.versions.map((v) => v.seq) : [])),
    ).toEqual([6, 4]);
  });

  it('refuses region and field filters on hidden scopes as if they did not exist (HIS-046)', () => {
    const exists = (s: string) =>
      ['region:rTerms000000000A', 'region:rSecret00000000B', 'field:fTenantName00001'].includes(s);
    for (const filter of [
      { region: 'rSecret00000000B' },
      { field: 'fTenantName00001' },
      { region: 'rNothing00000000' },
    ])
      expect(
        listHistory({ commits, versions, gate: all, hidden: HIDDEN, filter, scopeExists: exists }),
      ).toMatchObject({
        ok: false,
        code: 'not_found',
      });
    expect(
      listHistory({
        commits,
        versions,
        gate: all,
        hidden: NOTHING_HIDDEN,
        filter: { region: 'rSecret00000000B' },
        scopeExists: exists,
      }).ok,
    ).toBe(true);
  });

  it('lists commits that changed only hidden content without their content, as the class sees the log (HIS-046)', () => {
    const r = listHistory({ commits, versions, gate: all, hidden: HIDDEN });
    expect(r.ok && seqs(r.items)).toEqual(['g5-6', 'g3-4', 'g1-2']);
    // The group still counts commit 5, which touched only the hidden region; nothing names it.
    const g = r.ok ? (r.items[0] as HistoryGroup) : null;
    expect(g?.changes).toBe(2);
    expect(JSON.stringify(r)).not.toContain('rSecret00000000B');
    expect(JSON.stringify(r)).not.toContain('fTenantName00001');
  });

  it('nests groups by day', () => {
    const r = listHistory({
      commits: [c(1, 0), c(2, 24 * 60 + 1)],
      versions: [],
      gate: { min: 0, head: 2 },
    });
    expect(r.ok && byDay(r.items).map((d) => [d.day, d.items.length])).toEqual([
      ['2026-11-07', 1],
      ['2026-11-06', 1],
    ]);
  });
});
