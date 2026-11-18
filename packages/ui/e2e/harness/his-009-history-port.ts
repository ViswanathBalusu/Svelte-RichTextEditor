/**
 * A history port for the shell's browser tests of the history pane (HIS-009). It answers from a
 * fixed list: two editing groups (one with a person whose name the directory does not give, which
 * stands for an erased person) and one named version whose note holds markup, which must show as
 * text. `named` is a reader who sees named versions only (and who cannot name one); `failing`
 * rejects every call; `refusing` lists as `full` does but the service refuses to name a version
 * (HIS-006). `empty` lists nothing; `slow` holds the first list until `window.__historyRelease()` is
 * called, so the loading message can be read (HIS-009 criterion 7). Only `full` and `refusing` offer `createVersion`; a version named in `full` is added to
 * the list and the pane is told that it changed.
 */
import type {
  HistoryChoices,
  HistoryPaneItem,
  HistoryPaneQuery,
  HistoryPaneResult,
  HistoryCompareResult,
  HistoryPort,
  HistoryVersionOpen,
  HistoryWhoQuery,
  HistoryWhoResult,
  ResolveUsers,
} from '../../src/core-api.ts';

export type HistoryHarnessMode =
  'full' | 'named' | 'failing' | 'refusing' | 'empty' | 'slow' | 'versions' | 'assisted';

/** What the harness records of the versions the pane opens (HIS-010). */
export interface VersionLog {
  opened: number[];
  mounted: number;
  unmounted: number;
  closed: number;
  /** The outcome the next `openVersion` gives; absent: the version opens. */
  outcome?: 'forbidden' | 'not_found' | 'failed';
  /** HIS-013: the comparisons asked for, what the view was told to draw, and where focus was sent. */
  compared?: [number, number | null][];
  drawn?: number;
  deletions?: boolean[];
  focused?: number[];
  /** The outcome the next `compare` gives; absent: it succeeds. */
  compareOutcome?: 'forbidden' | 'not_found' | 'failed';
  /** HIS-015: the questions asked, the blocks the reader has selected, and the next outcome. */
  asked?: { seq: number; region: string | null; blocks: string[] | null }[];
  selected?: string[];
  whoOutcome?: 'forbidden' | 'not_found' | 'failed' | 'empty';
}

/** The `assisted` mode (HIS-017): the data has text an assistant wrote for a person. */
let assisted = false;

/** Groups end at a state a reader can open, in the `versions` mode. */
const GROUP_SEQ: Readonly<Record<string, number>> = { g1: 8, g2: 15 };

function versionLog(): VersionLog {
  const g = globalThis as { __versionLog?: VersionLog };
  g.__versionLog ??= { opened: [], mounted: 0, unmounted: 0, closed: 0 };
  return g.__versionLog;
}

/**
 * The `openVersion` of the `versions` mode. The pane cannot import the engine (`ui` never imports
 * `prosemirror-*`), so the harness draws plain text in the host element; the engine's own state is
 * tested in Node (`packages/engine/src/version-view.test.ts`). What this run checks is the pane's
 * side: the name, the focus, the leave and the refusal.
 */
function openVersion(
  seq: number,
  label: { time: string; name: string | null },
): Promise<HistoryVersionOpen> {
  const log = versionLog();
  log.opened.push(seq);
  if (log.outcome !== undefined) return Promise.resolve({ ok: false, reason: log.outcome });
  return Promise.resolve({
    ok: true,
    view: {
      seq,
      time: label.time,
      name: label.name,
      mount(target) {
        log.mounted++;
        const body = document.createElement('div');
        body.setAttribute('data-version-body', String(seq));
        body.textContent = `The document at version ${seq}.`;
        target.append(body);
        return () => {
          log.unmounted++;
          body.remove();
        };
      },
      selectedBlocks: () => [...(log.selected ?? [])],
      showComparison() {
        log.drawn = (log.drawn ?? 0) + 1;
      },
      showDeletions(on) {
        (log.deletions ??= []).push(on);
      },
      focusChange(index) {
        (log.focused ??= []).push(index);
        return true;
      },
      close() {
        log.closed++;
      },
    },
  });
}

/** The answer of "who wrote this": two people, one of them erased, and text brought back by a restore. */
function whoWrote(query: HistoryWhoQuery): Promise<HistoryWhoResult> {
  const log = versionLog();
  (log.asked ??= []).push({
    seq: query.seq,
    region: query.region,
    blocks: query.blocks ? [...query.blocks] : null,
  });
  if (log.whoOutcome === 'empty') return Promise.resolve({ ok: true, seq: query.seq, authors: [] });
  if (log.whoOutcome !== undefined) return Promise.resolve({ ok: false, reason: log.whoOutcome });
  return Promise.resolve({
    ok: true,
    seq: query.seq,
    authors: [
      ...(assisted
        ? [
            {
              user: 'u1',
              agent: 'drafting-assistant',
              runs: 1,
              firstTime: '2026-11-13T09:02:00Z',
              lastTime: '2026-11-13T09:02:00Z',
            },
          ]
        : []),
      { user: 'u1', runs: 2, firstTime: '2026-11-13T09:00:00Z', lastTime: '2026-11-13T09:04:00Z' },
      {
        user: 'u-erased',
        runs: 1,
        firstTime: '2026-11-13T09:01:00Z',
        lastTime: '2026-11-13T09:01:00Z',
      },
      {
        user: 'u2',
        restoredBy: 'u1',
        runs: 1,
        firstTime: '2026-11-12T08:00:00Z',
        lastTime: '2026-11-12T08:00:00Z',
      },
    ],
  });
}

/** The changes the harness's comparison returns: text, a field, an added block and a removed one. */
function compare(from: number, to: number | null): Promise<HistoryCompareResult> {
  const log = versionLog();
  (log.compared ??= []).push([from, to]);
  if (log.compareOutcome !== undefined)
    return Promise.resolve({ ok: false, reason: log.compareOutcome });
  return Promise.resolve({
    ok: true,
    comparison: {
      fromSeq: from,
      toSeq: to ?? 30,
      changes: [
        {
          kind: 'modified',
          blockId: 'pA',
          region: 'r1',
          user: 'u1',
          seq: 22,
          spans: [{ op: 'insert', at: 0, text: 'New', user: 'u1', seq: 22 }],
        },
        { kind: 'field', fieldId: 'f1', blockId: 'pB', user: 'u2', seq: 24 },
        ...(assisted
          ? [
              {
                kind: 'modified',
                blockId: 'pE',
                region: 'r1',
                user: 'u1',
                agent: 'drafting-assistant',
                seq: 23,
                spans: [
                  {
                    op: 'insert' as const,
                    at: 0,
                    text: 'Draft',
                    user: 'u1',
                    agent: 'drafting-assistant',
                    seq: 23,
                  },
                ],
              },
            ]
          : []),
        { kind: 'added', blockId: 'pC', user: 'u1', seq: 25 },
        { kind: 'removed', blockId: 'pD', region: 'r1', user: 'u2', seq: 26 },
      ],
    },
  });
}

/** The regions and fields each item touched; the service reads them from the per-scope table. */
const SCOPES: Readonly<Record<string, { regions: readonly string[]; fields: readonly string[] }>> =
  {
    g1: { regions: ['r1'], fields: [] },
    v1: { regions: [], fields: [] },
    g2: { regions: [], fields: ['f1'] },
  };

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
  assisted = mode === 'assisted';
  const versioned = mode === 'versions' || mode === 'assisted';
  let released = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  (globalThis as { __historyRelease?: () => void }).__historyRelease = () => {
    released = true;
    release();
  };
  const items: HistoryPaneItem[] = ITEMS.map((item) =>
    versioned && item.kind === 'group' && GROUP_SEQ[item.id] !== undefined
      ? {
          ...item,
          toSeq: GROUP_SEQ[item.id] as number,
          ...(assisted && item.id === 'g1'
            ? { assisted: [{ user: 'u1', agent: 'drafting-assistant' }] }
            : {}),
        }
      : item,
  );
  const listeners = new Set<() => void>();
  const createVersion: HistoryPort['createVersion'] =
    mode === 'full' || mode === 'refusing' || versioned
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
    ...(versioned || mode === 'named' ? { openVersion, compare, whoWrote } : {}),
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    choices: () => Promise.resolve(CHOICES),
    async list(query: HistoryPaneQuery): Promise<HistoryPaneResult> {
      if (mode === 'failing') throw new Error('history service down');
      if (mode === 'empty') return { items: [], nextCursor: null, namedOnly: false };
      if (mode === 'slow' && !released) await held;
      let shown = items.filter((item) => !named || item.kind === 'version');
      if (query.namedOnly) shown = shown.filter((item) => item.kind === 'version');
      if (query.region !== null)
        shown = shown.filter(
          (item) => SCOPES[item.id]?.regions.includes(query.region ?? '') ?? false,
        );
      if (query.field !== null)
        shown = shown.filter(
          (item) => SCOPES[item.id]?.fields.includes(query.field ?? '') ?? false,
        );
      if (query.user !== null)
        shown = shown.filter((item) =>
          item.kind === 'group'
            ? item.authors.includes(query.user ?? '')
            : item.creator === query.user,
        );
      return { items: shown, nextCursor: null, namedOnly: named };
    },
  };
}
