/**
 * The history pane's state (HIS-009, criteria 1 to 4 and 7, at the level of its state; the rendered
 * pane, keyboard and screen reader use are checked in a browser run, not here). The controller is
 * driven with a fake history port; the registry checks that the pane is offered only with the port,
 * and the source check shows that the pane is reached only through its dynamic import (criterion 6,
 * at source level; the bundle size needs a build).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type {
  CoreApi,
  HistoryChoices,
  HistoryPaneItem,
  HistoryPaneQuery,
  HistoryPaneResult,
  HistoryPort,
} from '../src/core-api.ts';
import {
  activeFilters,
  authorLabel,
  createHistoryController,
  NO_FILTER,
} from '../src/shell/history-pane.ts';
import { BUILT_IN_PANES, PaneRegistry } from '../src/shell/panes.ts';

const CHOICES: HistoryChoices = {
  regions: [{ id: 'r1', label: 'Summary' }],
  fields: [],
  people: [{ id: 'u1', label: 'Asha' }],
};

const group = (id: string, authors: string[], changes = 2): HistoryPaneItem => ({
  kind: 'group',
  id,
  day: '2026-11-13',
  from: '2026-11-13T09:00:00Z',
  to: '2026-11-13T09:04:00Z',
  authors,
  changes,
  origins: ['input'],
});

const named = (id: string, creator: string): HistoryPaneItem => ({
  kind: 'version',
  id,
  name: 'Board draft',
  note: 'Before the review',
  creator,
  time: '2026-11-13T10:00:00Z',
  seq: 12,
});

/** A port that answers from a script and records every query it was asked. */
function fakePort(
  answer: (q: HistoryPaneQuery) => Promise<HistoryPaneResult>,
  options: { resolve?: boolean; choices?: () => Promise<HistoryChoices> } = {},
): { port: HistoryPort; asked: HistoryPaneQuery[] } {
  const asked: HistoryPaneQuery[] = [];
  const port: HistoryPort = {
    list(query) {
      asked.push(query);
      return answer(query);
    },
    choices: options.choices ?? (() => Promise.resolve(CHOICES)),
    ...(options.resolve === false
      ? {}
      : {
          resolveUsers: (ids) =>
            Promise.resolve(
              ids.map((id) => (id === 'u-erased' ? null : { id, name: `Name of ${id}` })),
            ),
        }),
  };
  return { port, asked };
}

const ready = (items: HistoryPaneItem[], nextCursor: string | null = null) =>
  Promise.resolve({ items, nextCursor, namedOnly: false });

/** Lets the pending promises of the controller run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the pane shows its states, with a message for each (HIS-009, criterion 7)', () => {
  it('is loading until the first page arrives', async () => {
    let release: (value: HistoryPaneResult) => void = () => undefined;
    const { port } = fakePort(
      () => new Promise<HistoryPaneResult>((resolve) => (release = resolve)),
    );
    const ctl = createHistoryController(port);
    void ctl.reload();
    await settle();
    expect(ctl.state().status).toBe('loading');
    release({ items: [group('g1', ['u1'])], nextCursor: null, namedOnly: false });
    await settle();
    expect(ctl.state().status).toBe('ready');
  });

  it('is empty when the service returns no item, and says so', async () => {
    const { port } = fakePort(() => ready([]));
    const ctl = createHistoryController(port);
    await ctl.reload();
    expect(ctl.state().status).toBe('empty');
    expect(ctl.state().items).toEqual([]);
  });

  it('is an error when the port fails, and recovers when asked again', async () => {
    let fail = true;
    const { port } = fakePort(() =>
      fail ? Promise.reject(new Error('down')) : ready([group('g1', ['u1'])]),
    );
    const ctl = createHistoryController(port);
    await ctl.reload();
    expect(ctl.state().status).toBe('error');
    fail = false;
    await ctl.reload();
    expect(ctl.state().status).toBe('ready');
  });
});

describe('the list names authors through resolveUsers, and marks the erased (HIS-009, criteria 1 and 3)', () => {
  it('resolves each author once and gives the name', async () => {
    const { port } = fakePort(() => ready([group('g1', ['u1', 'u2']), named('v1', 'u1')]));
    const ctl = createHistoryController(port);
    await ctl.reload();
    const names = ctl.state().names;
    expect(authorLabel('u1', names)).toEqual({ known: true, name: 'Name of u1' });
    expect(authorLabel('u2', names)).toEqual({ known: true, name: 'Name of u2' });
  });

  it('gives an erased person an unknown label, not a name, and keeps their items', async () => {
    const { port } = fakePort(() => ready([group('g1', ['u-erased', 'u1'])]));
    const ctl = createHistoryController(port);
    await ctl.reload();
    expect(ctl.state().items).toHaveLength(1);
    expect(authorLabel('u-erased', ctl.state().names)).toEqual({ known: false, name: null });
    expect(authorLabel('u1', ctl.state().names).known).toBe(true);
  });

  it('shows the unknown label for everyone when the host gives no directory', async () => {
    const { port } = fakePort(() => ready([group('g1', ['u1'])]), { resolve: false });
    const ctl = createHistoryController(port);
    await ctl.reload();
    expect(authorLabel('u1', ctl.state().names).known).toBe(false);
  });

  it('keeps the list when the directory fails', async () => {
    const port: HistoryPort = {
      list: () => ready([group('g1', ['u1'])]),
      choices: () => Promise.resolve(CHOICES),
      resolveUsers: () => Promise.reject(new Error('directory down')),
    };
    const ctl = createHistoryController(port);
    await ctl.reload();
    expect(ctl.state().status).toBe('ready');
    expect(authorLabel('u1', ctl.state().names).known).toBe(false);
  });
});

describe('the filters narrow the list and show which are set (HIS-009, criterion 2)', () => {
  it('asks the service with each filter, and lists which are active', async () => {
    const { port, asked } = fakePort(() => ready([group('g1', ['u1'])]));
    const ctl = createHistoryController(port);
    await ctl.reload();
    await ctl.setFilter({ region: 'r1' });
    await ctl.setFilter({ user: 'u1', namedOnly: true });
    const last = asked.at(-1);
    expect(last).toEqual({ namedOnly: true, region: 'r1', field: null, user: 'u1', cursor: null });
    expect(activeFilters(ctl.state().filter)).toEqual(['named', 'region', 'user']);
  });

  it('clears the filters with the empty filter', async () => {
    const { port } = fakePort(() => ready([group('g1', ['u1'])]));
    const ctl = createHistoryController(port);
    await ctl.setFilter({ field: 'f1' });
    await ctl.setFilter(NO_FILTER);
    expect(activeFilters(ctl.state().filter)).toEqual([]);
  });

  it('gives the choices the host offers for the region, field and person selectors', async () => {
    const { port } = fakePort(() => ready([]));
    const ctl = createHistoryController(port);
    await ctl.reload();
    expect(ctl.state().choices).toEqual(CHOICES);
  });

  it('drops a reply to an older request, so a stale list never replaces a newer one', async () => {
    const pending: Array<(value: HistoryPaneResult) => void> = [];
    const { port } = fakePort(
      (q) =>
        new Promise<HistoryPaneResult>((resolve) => {
          if (q.region === null) resolve({ items: [], nextCursor: null, namedOnly: false });
          else pending.push(resolve);
        }),
    );
    const ctl = createHistoryController(port);
    await ctl.reload();
    const slow = ctl.setFilter({ region: 'r1' });
    const fast = ctl.setFilter({ region: null, user: 'u1' });
    // The older request (region r1) answers last with a list that must not be shown.
    pending[0]?.({ items: [group('stale', ['u1'])], nextCursor: null, namedOnly: false });
    await Promise.all([slow, fast]);
    expect(ctl.state().items.map((i) => i.id)).not.toContain('stale');
  });
});

describe('a reader who sees named versions only is told why (HIS-009, criterion 4)', () => {
  it('lists the named versions and sets the notice', async () => {
    const { port } = fakePort(() =>
      Promise.resolve({ items: [named('v1', 'u1')], nextCursor: null, namedOnly: true }),
    );
    const ctl = createHistoryController(port);
    await ctl.reload();
    expect(ctl.state().namedOnly).toBe(true);
    expect(ctl.state().items.every((item) => item.kind === 'version')).toBe(true);
  });
});

describe('paging keeps the earlier items and the cursor (HIS-008 through the pane)', () => {
  it('appends the next page with the cursor it was given', async () => {
    const { port, asked } = fakePort((q) =>
      q.cursor === null ? ready([group('g1', ['u1'])], 'c2') : ready([group('g2', ['u1'])], null),
    );
    const ctl = createHistoryController(port);
    await ctl.reload();
    await ctl.loadMore();
    expect(asked.at(-1)?.cursor).toBe('c2');
    expect(ctl.state().items.map((i) => i.id)).toEqual(['g1', 'g2']);
    expect(ctl.state().nextCursor).toBeNull();
  });
});

describe('the pane is offered only with the history port, and loaded on demand (HIS-009, criteria 1 and 6)', () => {
  const panes = new PaneRegistry(BUILT_IN_PANES);

  it('is not offered without the port, and is offered with it when the feature is announced', () => {
    const without = { history: undefined } as unknown as CoreApi;
    expect(panes.offered('history', without, ['history'])).toBe(false);
    const { port } = fakePort(() => ready([]));
    const withPort = { history: port } as unknown as CoreApi;
    expect(panes.offered('history', withPort, ['history'])).toBe(true);
    expect(panes.offered('history', withPort, [])).toBe(false);
  });

  it('gives the pane a loader, so the component is requested when the pane opens', () => {
    expect(panes.get('history')?.load).toBeTypeOf('function');
  });

  it('reaches the component only through its dynamic import, not a static one', () => {
    const shell = readFileSync(new URL('../src/shell/panes.ts', import.meta.url), 'utf8');
    const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(shell).toContain("import('../panes/HistoryPane.svelte')");
    expect(shell).not.toMatch(/^import .*HistoryPane\.svelte/m);
    // The component's file is not named in the entry. The names of the pane's data types
    // (HistoryPaneItem, HistoryPaneQuery, ...) are exported for the element's history port (UX-097).
    expect(index).not.toContain('HistoryPane.svelte');
    expect(index).not.toMatch(/\bHistoryPane\b/);
  });
});
