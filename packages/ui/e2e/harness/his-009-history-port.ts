/**
 * A history port for the shell's browser tests of the history pane (HIS-009). It answers from a
 * fixed list: two editing groups (one with a person whose name the directory does not give, which
 * stands for an erased person) and one named version whose note holds markup, which must show as
 * text. `named` is a reader who sees named versions only; `failing` rejects every call.
 */
import type {
  HistoryChoices,
  HistoryPaneItem,
  HistoryPaneQuery,
  HistoryPaneResult,
  HistoryPort,
  ResolveUsers,
} from '../../src/core-api.ts';

export type HistoryHarnessMode = 'full' | 'named' | 'failing';

const ITEMS: readonly HistoryPaneItem[] = [
  {
    kind: 'group',
    id: 'g1',
    day: '2026-11-13',
    from: '2026-11-13T09:00:00Z',
    to: '2026-11-13T09:04:00Z',
    authors: ['u1', 'u-erased'],
    changes: 3,
    origins: ['input', 'paste'],
  },
  {
    kind: 'version',
    id: 'v1',
    name: 'Board draft <img src=x onerror="window.__pwned=1">',
    note: '<b>Before review</b>',
    creator: 'u1',
    time: '2026-11-13T10:00:00Z',
    seq: 12,
  },
  {
    kind: 'group',
    id: 'g2',
    day: '2026-11-13',
    from: '2026-11-13T11:00:00Z',
    to: '2026-11-13T11:02:00Z',
    authors: ['u2'],
    changes: 1,
    origins: ['format'],
  },
];

const CHOICES: HistoryChoices = {
  regions: [{ id: 'r1', label: 'Terms' }],
  fields: [{ id: 'f1', label: 'Name' }],
  people: [
    { id: 'u1', label: 'Ada Lovelace' },
    { id: 'u2', label: 'Grace Hopper' },
  ],
};

export function historyPort(mode: HistoryHarnessMode, resolveUsers: ResolveUsers): HistoryPort {
  const named = mode === 'named';
  return {
    resolveUsers,
    choices: () => Promise.resolve(CHOICES),
    list(query: HistoryPaneQuery): Promise<HistoryPaneResult> {
      if (mode === 'failing') return Promise.reject(new Error('history service down'));
      let items = ITEMS.filter((item) => !named || item.kind === 'version');
      if (query.namedOnly) items = items.filter((item) => item.kind === 'version');
      if (query.user !== null)
        items = items.filter((item) =>
          item.kind === 'group'
            ? item.authors.includes(query.user ?? '')
            : item.creator === query.user,
        );
      return Promise.resolve({ items, nextCursor: null, namedOnly: named });
    },
  };
}
