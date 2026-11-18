/**
 * "Who wrote this" in the history pane (HIS-015), at the level of its controller: the question is
 * about the version that is open (criterion 3), a region or the selected passage narrows it
 * (criterion 1), the host's refusals and an empty answer are states with a reason, a person the host
 * does not resolve stays unknown (HIS-038), and a late answer never replaces a newer one. The drawn
 * pane, its names and its colours are checked in the browser run.
 */
import { describe, expect, it } from 'vitest';
import type {
  HistoryAuthorLine,
  HistoryPaneItem,
  HistoryPort,
  HistoryVersionView,
  HistoryWhoQuery,
  HistoryWhoResult,
} from '../src/core-api.ts';
import { createHistoryController } from '../src/shell/history-pane.ts';
import { createWhoController, orderAuthors, whoUsers } from '../src/shell/history-who.ts';

const version: HistoryPaneItem = {
  kind: 'version',
  id: 'v1',
  name: 'Board draft',
  note: null,
  creator: 'u1',
  time: '2026-11-13T10:00:00Z',
  seq: 12,
};

const line = (
  user: string,
  first: string,
  extra: Partial<HistoryAuthorLine> = {},
): HistoryAuthorLine => ({
  user,
  runs: 1,
  firstTime: first,
  lastTime: first,
  ...extra,
});

function setup(
  answer: (q: HistoryWhoQuery) => Promise<HistoryWhoResult>,
  selected: string[] | undefined = [],
) {
  const asked: HistoryWhoQuery[] = [];
  const view = (seq: number): HistoryVersionView => ({
    seq,
    time: 't',
    name: null,
    mount: () => () => undefined,
    ...(selected === undefined ? {} : { selectedBlocks: () => selected }),
    close: () => undefined,
  });
  const port: HistoryPort = {
    list: () => Promise.resolve({ items: [version], nextCursor: null, namedOnly: false }),
    choices: () => Promise.resolve({ regions: [], fields: [], people: [] }),
    resolveUsers: (ids) =>
      Promise.resolve(
        ids.map((id) => (id === 'u-erased' ? null : { id, name: `Name ${id}` })),
      ) as never,
    openVersion: (seq) => Promise.resolve({ ok: true, view: view(seq) }),
    whoWrote: (q) => {
      asked.push(q);
      return answer(q);
    },
  };
  const history = createHistoryController(port);
  const who = createWhoController(port, history);
  return { history, who, asked };
}

const ok =
  (authors: HistoryAuthorLine[]) =>
  (q: HistoryWhoQuery): Promise<HistoryWhoResult> =>
    Promise.resolve({ ok: true, seq: q.seq, authors });

describe('who wrote this, in the pane (HIS-015)', () => {
  it('needs an open version, and asks about that version (criterion 3)', async () => {
    const t = setup(ok([line('u1', '2026-11-13T09:00:00Z')]));
    await t.history.reload();
    expect(await t.who.ask({ kind: 'document' })).toBe(false);
    expect(t.asked).toEqual([]);
    await t.history.open(version);
    expect(await t.who.ask({ kind: 'document' })).toBe(true);
    expect(t.asked).toEqual([{ seq: 12, region: null, blocks: null }]);
    expect(t.who.state()).toMatchObject({ status: 'ready', seq: 12 });
  });

  it('narrows to a region or to the selected blocks (criterion 1)', async () => {
    const t = setup(ok([line('u1', 'a')]), ['pA', 'pB']);
    await t.history.reload();
    await t.history.open(version);
    await t.who.ask({ kind: 'region', id: 'r1' });
    await t.who.ask({ kind: 'selection' });
    expect(t.asked).toEqual([
      { seq: 12, region: 'r1', blocks: null },
      { seq: 12, region: null, blocks: ['pA', 'pB'] },
    ]);
  });

  it('does not ask the host when a passage is asked for and nothing is selected', async () => {
    const t = setup(ok([]), []);
    await t.history.reload();
    await t.history.open(version);
    expect(await t.who.ask({ kind: 'selection' })).toBe(false);
    expect(t.who.state().status).toBe('nothing');
    expect(t.asked).toEqual([]);
  });

  it('lists the authors earliest first, names them, and leaves an erased person unknown', async () => {
    const t = setup(
      ok([
        line('u2', '2026-11-13T09:05:00Z'),
        line('u-erased', '2026-11-13T09:01:00Z'),
        line('u3', '2026-11-12T08:00:00Z', { restoredBy: 'u2' }),
      ]),
    );
    await t.history.reload();
    await t.history.open(version);
    await t.who.ask({ kind: 'document' });
    const s = t.who.state();
    expect(s.authors.map((a) => a.user)).toEqual(['u3', 'u-erased', 'u2']);
    expect(s.names.get('u2')).toBe('Name u2');
    expect(s.names.get('u3')).toBe('Name u3');
    // The directory does not know the erased person: the pane shows the unknown-person label.
    expect(s.names.get('u-erased')).toBeNull();
  });

  it('keeps who restored text among the people it names', () => {
    expect(whoUsers([line('u3', 'a', { restoredBy: 'u2' }), line('u1', 'b')])).toEqual([
      'u3',
      'u2',
      'u1',
    ]);
    expect(
      orderAuthors([line('b', '2'), line('a', '2'), line('c', '1')]).map((a) => a.user),
    ).toEqual(['c', 'a', 'b']);
  });

  it('shows what the host refused, an empty answer, and a failure', async () => {
    for (const reason of ['forbidden', 'not_found', 'failed'] as const) {
      const t = setup(() => Promise.resolve({ ok: false, reason }));
      await t.history.reload();
      await t.history.open(version);
      expect(await t.who.ask({ kind: 'document' })).toBe(false);
      expect(t.who.state()).toMatchObject({ status: 'refused', reason });
    }
    const empty = setup(ok([]));
    await empty.history.reload();
    await empty.history.open(version);
    await empty.who.ask({ kind: 'document' });
    expect(empty.who.state()).toMatchObject({ status: 'ready', authors: [] });
    const broken = setup(() => Promise.reject(new Error('network')));
    await broken.history.reload();
    await broken.history.open(version);
    await broken.who.ask({ kind: 'document' });
    expect(broken.who.state()).toMatchObject({ status: 'refused', reason: 'failed' });
  });

  it('drops a late answer when a newer question was asked, and clears on request', async () => {
    const waiting: (() => void)[] = [];
    const t = setup(
      (q) =>
        new Promise<HistoryWhoResult>((resolve) =>
          waiting.push(() =>
            resolve({ ok: true, seq: q.seq, authors: [line(`u${waiting.length}`, 'a')] }),
          ),
        ),
    );
    await t.history.reload();
    await t.history.open(version);
    const first = t.who.ask({ kind: 'document' });
    const second = t.who.ask({ kind: 'region', id: 'r1' });
    waiting[1]?.();
    await second;
    waiting[0]?.();
    expect(await first).toBe(false);
    expect(t.who.state().authors.map((a) => a.user)).toEqual(['u2']);
    t.who.clear();
    expect(t.who.state()).toMatchObject({ status: 'idle', authors: [] });
  });
});
