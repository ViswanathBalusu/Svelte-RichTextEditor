/**
 * A history port for the shell's browser tests of the history pane (HIS-009). It answers from a
 * fixed list: two editing groups (one with a person whose name the directory does not give, which
 * stands for an erased person) and one named version whose note holds markup, which must show as
 * text. `named` is a reader who sees named versions only (and who cannot name one); `failing`
 * rejects every call; `refusing` lists as `full` does but the service refuses to name a version
 * (HIS-006). Only `full` and `refusing` offer `createVersion`; a version named in `full` is added to
 * the list and the pane is told that it changed.
 */
import type {
  HistoryChoices,
  HistoryPaneItem,
  HistoryPaneQuery,
  HistoryPaneResult,
  HistoryPort,
  ResolveUsers,
} from '../../src/core-api.ts';

export type HistoryHarnessMode = 'full' | 'named' | 'failing' | 'refusing';

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
  const items: HistoryPaneItem[] = [...ITEMS];
  const listeners = new Set<() => void>();
  const createVersion: HistoryPort['createVersion'] =
    mode === 'full' || mode === 'refusing'
      ? (input) => {
          if (mode === 'refusing') return Promise.resolve({ ok: false, reason: 'forbidden' });
          items.push({
            kind: 'version',
            id: `v${items.length + 1}`,
            name: input.name,
            note: input.note,
            creator: 'u1',
            time: '2026-11-14T08:00:00Z',
            seq: 20 + items.length,
          });
          for (const listener of [...listeners]) listener();
          return Promise.resolve({ ok: true });
        }
      : undefined;
  return {
    resolveUsers,
    ...(createVersion ? { createVersion } : {}),
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    choices: () => Promise.resolve(CHOICES),
    list(query: HistoryPaneQuery): Promise<HistoryPaneResult> {
      if (mode === 'failing') return Promise.reject(new Error('history service down'));
      let shown = items.filter((item) => !named || item.kind === 'version');
      if (query.namedOnly) shown = shown.filter((item) => item.kind === 'version');
      if (query.user !== null)
        shown = shown.filter((item) =>
          item.kind === 'group'
            ? item.authors.includes(query.user ?? '')
            : item.creator === query.user,
        );
      return Promise.resolve({ items: shown, nextCursor: null, namedOnly: named });
    },
  };
}
