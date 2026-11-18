/**
 * The comparison in the history pane (HIS-013), at the level of its rules and its controller: which
 * versions are offered (only those the list shows, criterion 6), how changes are ordered and
 * navigated (criterion 2), the summary by region (criterion 3), field changes with their user
 * (criterion 5), and the order of the two ends. The drawn pane is checked in the browser run.
 */
import { describe, expect, it } from 'vitest';
import type {
  HistoryChange,
  HistoryCompareResult,
  HistoryPaneItem,
  HistoryPort,
  HistoryVersionView,
} from '../src/core-api.ts';
import {
  authorOf,
  compareChoices,
  createCompareController,
  fieldChanges,
  nextIndex,
  orderedEnds,
  previousIndex,
  summaryByRegion,
  usersOf,
} from '../src/shell/history-compare.ts';
import { createHistoryController } from '../src/shell/history-pane.ts';

const group = (id: string, toSeq?: number): HistoryPaneItem => ({
  kind: 'group',
  id,
  day: '2026-11-13',
  from: '2026-11-13T09:00:00Z',
  to: '2026-11-13T09:04:00Z',
  authors: ['u1'],
  changes: 1,
  origins: ['input'],
  ...(toSeq === undefined ? {} : { toSeq }),
});

const named: HistoryPaneItem = {
  kind: 'version',
  id: 'v1',
  name: 'Board draft',
  note: null,
  creator: 'u1',
  time: '2026-11-13T10:00:00Z',
  seq: 12,
};

const CHANGES: HistoryChange[] = [
  {
    kind: 'modified',
    blockId: 'pA',
    region: 'r1',
    user: 'u1',
    spans: [{ op: 'insert', at: 0, text: 'x', user: 'u1' }],
  },
  { kind: 'field', fieldId: 'f1', blockId: 'pB', user: 'u2' },
  { kind: 'added', blockId: 'pC', user: 'u1' },
  { kind: 'removed', blockId: 'pD', region: 'r1' },
  { kind: 'modified', blockId: 'pE', spans: [{ op: 'delete', at: 2, text: 'y', user: 'u3' }] },
];

describe('the versions a comparison offers (HIS-013 criterion 6)', () => {
  it('offers only list items that have a state, so nothing below the gate appears', () => {
    const choices = compareChoices([group('g1', 8), group('g2'), named]);
    expect(choices.map((c) => c.seq)).toEqual([8, 12]);
    expect(choices[1]).toMatchObject({ key: 'version:v1', name: 'Board draft' });
    expect(compareChoices([])).toEqual([]);
  });

  it('puts the older state first, and the current document last', () => {
    const [a, b] = compareChoices([group('g1', 8), named]);
    expect(orderedEnds(b!, a!)).toEqual({ from: a, to: b });
    expect(orderedEnds(a!, b!)).toEqual({ from: a, to: b });
    expect(orderedEnds(b!, null)).toEqual({ from: b, to: null });
  });
});

describe('the changes of a comparison (HIS-013 criteria 2, 3 and 5)', () => {
  it('moves to the next and previous change and wraps at the ends', () => {
    expect(nextIndex(-1, 3)).toBe(0);
    expect(nextIndex(2, 3)).toBe(0);
    expect(previousIndex(-1, 3)).toBe(2);
    expect(previousIndex(0, 3)).toBe(2);
    expect(previousIndex(2, 3)).toBe(1);
    expect(nextIndex(-1, 0)).toBe(-1);
    expect(previousIndex(0, 0)).toBe(-1);
  });

  it('credits a change to its user, else to the user of its first span', () => {
    expect(authorOf(CHANGES[0]!)).toBe('u1');
    expect(authorOf(CHANGES[4]!)).toBe('u3');
    expect(authorOf(CHANGES[3]!)).toBeNull();
    expect(usersOf(CHANGES)).toEqual(['u1', 'u2', 'u3']);
  });

  it('groups the summary by region in the order the regions first appear', () => {
    expect(summaryByRegion(CHANGES)).toEqual([
      { region: 'r1', count: 2, kinds: { modified: 1, removed: 1 } },
      { region: null, count: 3, kinds: { field: 1, added: 1, modified: 1 } },
    ]);
    expect(summaryByRegion([])).toEqual([]);
  });

  it('lists the field changes with the user who made them', () => {
    expect(fieldChanges(CHANGES)).toEqual([{ field: 'f1', user: 'u2', index: 1 }]);
  });
});

interface Drawn {
  changes: readonly HistoryChange[] | null;
  deletions: boolean[];
  focused: number[];
  closed: number;
}

function harness(
  compareResult: () => Promise<HistoryCompareResult>,
  resolve: HistoryPort['resolveUsers'] = (ids) =>
    Promise.resolve(ids.map((id) => ({ id, name: `Name ${id}` }))) as never,
) {
  const drawn: Drawn = { changes: null, deletions: [], focused: [], closed: 0 };
  const opened: number[] = [];
  const compared: [number, number | null][] = [];
  const port: HistoryPort = {
    list: () =>
      Promise.resolve({ items: [group('g1', 8), named], nextCursor: null, namedOnly: false }),
    choices: () => Promise.resolve({ regions: [], fields: [], people: [] }),
    resolveUsers: resolve,
    openVersion: (seq, label) => {
      opened.push(seq);
      const view: HistoryVersionView = {
        seq,
        time: label.time,
        name: label.name,
        mount: () => () => undefined,
        showComparison: (changes) => {
          drawn.changes = changes;
        },
        showDeletions: (on) => drawn.deletions.push(on),
        focusChange: (i) => {
          drawn.focused.push(i);
          return true;
        },
        close: () => {
          drawn.closed++;
        },
      };
      return Promise.resolve({ ok: true, view });
    },
    compare: (from, to) => {
      compared.push([from, to]);
      return compareResult();
    },
  };
  const history = createHistoryController(port);
  const compare = createCompareController(port, history);
  return { port, history, compare, drawn, opened, compared };
}

const ok = (toSeq: number): Promise<HistoryCompareResult> =>
  Promise.resolve({ ok: true, comparison: { fromSeq: 8, toSeq, changes: CHANGES } });

describe('the comparison controller (HIS-013)', () => {
  it('keeps the changes of an erased person and leaves them without a name (HIS-038 criterion 2)', async () => {
    const changes: HistoryChange[] = [
      { kind: 'added', blockId: 'pA', user: 'u-erased' },
      { kind: 'added', blockId: 'pB', user: 'u1' },
    ];
    const h = harness(
      () => Promise.resolve({ ok: true, comparison: { fromSeq: 8, toSeq: 12, changes } }),
      (ids) =>
        Promise.resolve(
          ids.map((id) => (id === 'u-erased' ? null : { id, name: `Name ${id}` })),
        ) as never,
    );
    await h.history.reload();
    const [a, b] = compareChoices(h.history.state().items);
    expect(await h.compare.run(b!, a!)).toBe(true);
    const s = h.compare.state();
    // Both changes stay in the list; the host does not know the erased person, so no name is shown.
    expect(s.rows).toHaveLength(2);
    expect(authorOf(s.rows[0]!.change)).toBe('u-erased');
    expect(s.names.get('u-erased')).toBeNull();
    expect(s.names.get('u1')).toBe('Name u1');
  });

  it('compares, opens the newer version read-only, hands it the changes and moves between them', async () => {
    const h = harness(() => ok(12));
    await h.history.reload();
    const [a, b] = compareChoices(h.history.state().items);
    expect(await h.compare.run(b!, a!)).toBe(true);
    expect(h.compared).toEqual([[8, 12]]);
    expect(h.opened).toEqual([12]);
    expect(h.drawn.changes).toBe(CHANGES);
    const s = h.compare.state();
    expect(s.status).toBe('ready');
    expect(s.rows).toHaveLength(5);
    expect(s.names.get('u3')).toBe('Name u3');

    expect(h.compare.next()).toBe(true);
    expect(h.compare.state().index).toBe(0);
    h.compare.previous();
    expect(h.compare.state().index).toBe(4);
    expect(h.drawn.focused).toEqual([0, 4]);
    h.compare.setShowDeleted(true);
    expect(h.drawn.deletions).toEqual([false, true]);

    h.compare.close();
    expect(h.drawn.closed).toBe(1);
    expect(h.compare.state().status).toBe('idle');
    expect(h.history.state().viewing).toBeNull();
  });

  it('compares with the current document when the newer end is null', async () => {
    const h = harness(() => ok(40));
    await h.history.reload();
    const [a] = compareChoices(h.history.state().items);
    await h.compare.run(a!, null);
    expect(h.compared).toEqual([[8, null]]);
    expect(h.opened).toEqual([40]);
  });

  it('shows a refusal and opens no version', async () => {
    for (const reason of ['forbidden', 'not_found', 'failed'] as const) {
      const h = harness(() => Promise.resolve({ ok: false, reason }));
      await h.history.reload();
      const [a] = compareChoices(h.history.state().items);
      expect(await h.compare.run(a!, null)).toBe(false);
      expect(h.compare.state()).toMatchObject({ status: 'refused', reason });
      expect(h.opened).toEqual([]);
    }
    const h = harness(() => Promise.reject(new Error('network')));
    await h.history.reload();
    const [a] = compareChoices(h.history.state().items);
    await h.compare.run(a!, null);
    expect(h.compare.state()).toMatchObject({ status: 'refused', reason: 'failed' });
  });

  it('keeps the newest of two comparisons when the earlier one answers late', async () => {
    const waiting: (() => void)[] = [];
    const h = harness(
      () =>
        new Promise<HistoryCompareResult>((resolve) =>
          waiting.push(() =>
            resolve({ ok: true, comparison: { fromSeq: 1, toSeq: 2, changes: [] } }),
          ),
        ),
    );
    await h.history.reload();
    const [a] = compareChoices(h.history.state().items);
    const first = h.compare.run(a!, null);
    const second = h.compare.run(a!, null);
    waiting[1]?.();
    await second;
    waiting[0]?.();
    expect(await first).toBe(false);
    expect(h.compare.state().status).toBe('ready');
    expect(h.compare.state().rows).toHaveLength(0);
  });
});
