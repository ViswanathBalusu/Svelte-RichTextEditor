/**
 * Opening an old version from the history pane (HIS-010), at the level of the pane's state: the
 * controller opens the state the host gives, keeps it apart from the list, refuses what the host
 * refuses, releases it on leaving, and never lets a late reply replace a newer choice. The drawn
 * pane (focus, name, mount) is checked in a browser run.
 */
import { describe, expect, it } from 'vitest';
import type {
  HistoryPaneItem,
  HistoryPort,
  HistoryVersionOpen,
  HistoryVersionView,
} from '../src/core-api.ts';
import { createHistoryController, itemKey, openingOf } from '../src/shell/history-pane.ts';

const version: HistoryPaneItem = {
  kind: 'version',
  id: 'v1',
  name: 'Board draft',
  note: null,
  creator: 'u1',
  time: '2026-11-13T10:00:00Z',
  seq: 12,
};

const groupWithSeq: HistoryPaneItem = {
  kind: 'group',
  id: 'g1',
  day: '2026-11-13',
  from: '2026-11-13T09:00:00Z',
  to: '2026-11-13T09:04:00Z',
  authors: ['u1'],
  changes: 3,
  origins: ['input'],
  toSeq: 9,
};

const groupWithoutSeq: HistoryPaneItem = { ...groupWithSeq, id: 'g2' };
delete (groupWithoutSeq as { toSeq?: number }).toSeq;

interface Probe {
  view: HistoryVersionView;
  closed: () => number;
}

function probeView(seq: number, time: string, name: string | null): Probe {
  let closed = 0;
  return {
    view: {
      seq,
      time,
      name,
      mount: () => () => undefined,
      close: () => {
        closed++;
      },
    },
    closed: () => closed,
  };
}

function portWith(open: HistoryPort['openVersion']): HistoryPort {
  const port: HistoryPort = {
    list: () =>
      Promise.resolve({ items: [version, groupWithSeq], nextCursor: null, namedOnly: false }),
    choices: () => Promise.resolve({ regions: [], fields: [], people: [] }),
  };
  if (open !== undefined) return { ...port, openVersion: open };
  return port;
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('opening an old version from the pane (HIS-010)', () => {
  it('opens the state the host gives for a named version and for the end of a group (criterion 1)', async () => {
    const asked: { seq: number; time: string; name: string | null }[] = [];
    const probes: Probe[] = [];
    const ctl = createHistoryController(
      portWith(async (seq, label) => {
        asked.push({ seq, ...label });
        const p = probeView(seq, label.time, label.name);
        probes.push(p);
        return { ok: true, view: p.view } satisfies HistoryVersionOpen;
      }),
    );
    await ctl.reload();
    expect(await ctl.open(version)).toBe(true);
    const s = ctl.state().viewing;
    expect(s?.status).toBe('open');
    expect(s?.status === 'open' && s.view.seq).toBe(12);
    expect(asked[0]).toEqual({ seq: 12, time: '2026-11-13T10:00:00Z', name: 'Board draft' });

    // Another version replaces it, and the first state is released.
    expect(await ctl.open(groupWithSeq)).toBe(true);
    expect(asked[1]).toEqual({ seq: 9, time: '2026-11-13T09:04:00Z', name: null });
    expect(probes[0]?.closed()).toBe(1);
    expect(probes[1]?.closed()).toBe(0);
  });

  it('offers nothing to open for an item with no state, or without the host method', async () => {
    expect(openingOf(groupWithoutSeq)).toBeNull();
    const ctl = createHistoryController(portWith(undefined));
    await ctl.reload();
    expect(await ctl.open(version)).toBe(false);
    expect(ctl.state().viewing).toBeNull();
    const withMethod = createHistoryController(
      portWith(() => Promise.reject(new Error('must not be called'))),
    );
    expect(await withMethod.open(groupWithoutSeq)).toBe(false);
    expect(withMethod.state().viewing).toBeNull();
  });

  it('says what the host refused: forbidden, gone, or failed, and shows no version (criterion 5)', async () => {
    for (const reason of ['forbidden', 'not_found', 'failed'] as const) {
      const ctl = createHistoryController(portWith(async () => ({ ok: false, reason })));
      await ctl.reload();
      expect(await ctl.open(version)).toBe(false);
      expect(ctl.state().viewing).toEqual({
        status: 'refused',
        key: itemKey(version),
        seq: 12,
        reason,
      });
    }
    // A host that throws is a failure, not a crash.
    const ctl = createHistoryController(portWith(() => Promise.reject(new Error('network'))));
    expect(await ctl.open(version)).toBe(false);
    expect(ctl.state().viewing?.status === 'refused' && ctl.state().viewing).toMatchObject({
      reason: 'failed',
    });
  });

  it('releases the state when the user leaves, and the list is as it was (criterion 6, state)', async () => {
    const p = probeView(12, version.kind === 'version' ? version.time : '', 'Board draft');
    const ctl = createHistoryController(portWith(async () => ({ ok: true, view: p.view })));
    await ctl.reload();
    const before = ctl.state().items;
    await ctl.open(version);
    ctl.leave();
    expect(p.closed()).toBe(1);
    expect(ctl.state().viewing).toBeNull();
    expect(ctl.state().items).toBe(before);
    ctl.leave();
    expect(p.closed()).toBe(1);
  });

  it('closes a version that arrives after the user left or chose another (stale reply)', async () => {
    const waiting: ((o: HistoryVersionOpen) => void)[] = [];
    const probes: Probe[] = [];
    const ctl = createHistoryController(
      portWith(
        (seq, label) =>
          new Promise((resolve) => {
            const p = probeView(seq, label.time, label.name);
            probes.push(p);
            waiting.push(() => resolve({ ok: true, view: p.view }));
          }),
      ),
    );
    await ctl.reload();
    const first = ctl.open(version);
    await flush();
    expect(ctl.state().viewing?.status).toBe('opening');
    ctl.leave();
    waiting[0]?.({ ok: false, reason: 'failed' });
    expect(await first).toBe(false);
    expect(probes[0]?.closed()).toBe(1);
    expect(ctl.state().viewing).toBeNull();

    // Two openings in a row: only the later one is shown, the earlier one is closed on arrival.
    const a = ctl.open(version);
    await flush();
    const b = ctl.open(groupWithSeq);
    await flush();
    waiting[2]?.({ ok: false, reason: 'failed' });
    waiting[1]?.({ ok: false, reason: 'failed' });
    expect(await b).toBe(true);
    expect(await a).toBe(false);
    expect(probes[1]?.closed()).toBe(1);
    expect(probes[2]?.closed()).toBe(0);
    const now = ctl.state().viewing;
    expect(now?.status === 'open' && now.seq).toBe(9);
  });

  it('releases an open version when the pane closes', async () => {
    const p = probeView(12, 't', null);
    const ctl = createHistoryController(portWith(async () => ({ ok: true, view: p.view })));
    await ctl.reload();
    await ctl.open(version);
    ctl.dispose();
    expect(p.closed()).toBe(1);
  });
});
