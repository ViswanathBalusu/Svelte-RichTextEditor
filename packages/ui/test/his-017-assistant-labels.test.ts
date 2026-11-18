/**
 * Which changes of a comparison an assistant wrote for a person (HIS-017 criterion 3), at the level
 * of the rules: the agent comes from the change or from its first span that names one, a person's
 * own change has none, and the people of an assisted group are looked up with the other authors.
 * The drawn labels, with their icon, are checked in the browser run (e2e/his-017-assistant-labels).
 */
import { describe, expect, it } from 'vitest';
import type { HistoryChange, HistoryPaneItem, HistoryPort } from '../src/core-api.ts';
import { agentOf, assistantChanges } from '../src/shell/history-compare.ts';
import { createHistoryController } from '../src/shell/history-pane.ts';
import { BUILT_IN_ICONS } from '../src/icons/icons.ts';

describe('agentOf and assistantChanges', () => {
  const own: HistoryChange = {
    kind: 'modified',
    user: 'u1',
    spans: [{ op: 'insert', at: 0, text: 'a', user: 'u1' }],
  };
  const direct: HistoryChange = { kind: 'modified', user: 'u1', agent: 'drafter' };
  const inSpan: HistoryChange = {
    kind: 'modified',
    spans: [
      { op: 'insert', at: 0, text: 'a', user: 'u2' },
      { op: 'insert', at: 1, text: 'b', user: 'u2', agent: 'checker' },
    ],
  };

  it('names the agent of the change, or of its first span that has one, and none for a person', () => {
    expect(agentOf(own)).toBeNull();
    expect(agentOf(direct)).toBe('drafter');
    expect(agentOf(inSpan)).toBe('checker');
  });

  it('lists the assistant changes with their place and the person they are credited to', () => {
    expect(assistantChanges([own, direct, inSpan])).toEqual([
      { index: 1, change: direct, agent: 'drafter', user: 'u1' },
      { index: 2, change: inSpan, agent: 'checker', user: 'u2' },
    ]);
    expect(assistantChanges([own])).toEqual([]);
  });
});

describe('the history list', () => {
  it('looks up the people an assistant acted for, as it looks up the authors', async () => {
    const group: HistoryPaneItem = {
      kind: 'group',
      id: 'g',
      day: '2026-11-13',
      from: 'a',
      to: 'b',
      authors: ['u1'],
      assisted: [{ user: 'u9', agent: 'drafter' }],
      changes: 2,
      origins: ['assistant'],
    };
    const asked: string[][] = [];
    const port: HistoryPort = {
      resolveUsers: (ids) => {
        asked.push([...ids]);
        return Promise.resolve(ids.map((id) => ({ id, name: `name ${id}` })));
      },
      choices: () => Promise.resolve({ regions: [], fields: [], people: [] }),
      list: () => Promise.resolve({ items: [group], nextCursor: null, namedOnly: false }),
    };
    const ctl = createHistoryController(port);
    await ctl.reload();
    expect(asked.flat().sort()).toEqual(['u1', 'u9']);
    expect(ctl.state().names.get('u9')).toBe('name u9');
    ctl.dispose();
  });
});

describe('the assistant icon', () => {
  it('is a drawing of the built-in set', () => {
    expect(BUILT_IN_ICONS['assistant']?.paths.length).toBeGreaterThan(0);
  });
});
