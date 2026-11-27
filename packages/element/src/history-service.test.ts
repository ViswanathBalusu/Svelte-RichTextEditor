/** The shell's history port over the backend's (UX-097 criterion 5; HIS-008). */
import { describe, expect, it } from 'vitest';
import type { HistoryPort as WireHistoryPort } from '@docedit/protocol';
import { historyService, paneItemOf } from './history-service.ts';

const GROUP = {
  type: 'group',
  day: '2026-11-27',
  fromSeq: 3,
  toSeq: 5,
  fromTime: '2026-11-27T10:00:00Z',
  toTime: '2026-11-27T10:04:00Z',
  changes: 3,
  authors: [{ user: 'olivia' }, { user: 'bob', agent: 'assistant-1' }, { user: 'olivia' }],
  sessions: ['s1'],
  origins: ['input', 'prefill'],
  versions: [],
};

function fakePort(items: unknown[], nextCursor: string | null = null) {
  const calls: unknown[] = [];
  const port = {
    history: async (_doc: string, query?: unknown) => {
      calls.push(query);
      return { items, nextCursor };
    },
  } as unknown as WireHistoryPort;
  return { port, calls };
}

describe('paneItemOf', () => {
  it('names the authors of a group once each, with the agent that acted for them', () => {
    expect(paneItemOf(GROUP)).toEqual({
      kind: 'group',
      id: 'g3-5',
      day: '2026-11-27',
      from: '2026-11-27T10:00:00Z',
      to: '2026-11-27T10:04:00Z',
      authors: ['olivia', 'bob'],
      assisted: [{ user: 'bob', agent: 'assistant-1' }],
      changes: 3,
      origins: ['input', 'prefill'],
      toSeq: 5,
    });
  });

  it('lists a named version and leaves out what it does not know', () => {
    const named = {
      type: 'version',
      version: { seq: 4, kind: 'named', name: 'Draft', createdBy: 'olivia', createdAt: 't' },
    };
    expect(paneItemOf(named)).toEqual({
      kind: 'version',
      id: 'v4',
      name: 'Draft',
      creator: 'olivia',
      time: 't',
      seq: 4,
    });
    expect(
      paneItemOf({ type: 'version', version: { seq: 4, kind: 'export', createdBy: 'a' } }),
    ).toBeNull();
    expect(paneItemOf({ type: 'group' })).toBeNull();
    expect(paneItemOf('x')).toBeNull();
  });
});

describe('historyService', () => {
  it('reads the list with the pane filters and gives the people the pane may filter by', async () => {
    const { port, calls } = fakePort([GROUP, { nope: true }], 'next');
    const history = historyService({ port, docId: 'd1' });
    const result = await history.list({
      namedOnly: true,
      region: null,
      field: null,
      user: 'olivia',
      cursor: 'c0',
    });
    expect(calls).toEqual([{ limit: 50, namedOnly: true, user: 'olivia', cursor: 'c0' }]);
    expect(result.nextCursor).toBe('next');
    expect(result.items.map((i) => i.kind)).toEqual(['group']);
    expect((await history.choices()).people.map((p) => p.id)).toEqual(['olivia', 'bob']);
  });

  it('asks the host directory for names', async () => {
    const { port } = fakePort([]);
    const history = historyService({
      port,
      docId: 'd1',
      resolveUsers: () => async (ids) => ids.map((id) => ({ id, name: id.toUpperCase() })),
    });
    expect(await history.resolveUsers?.(['olivia'])).toEqual([{ id: 'olivia', name: 'OLIVIA' }]);
  });
  it('answers a missing directory with unknown people', async () => {
    const { port } = fakePort([]);
    const history = historyService({ port, docId: 'd1', resolveUsers: () => null });
    expect(await history.resolveUsers?.(['a'])).toEqual([null]);
  });
});
