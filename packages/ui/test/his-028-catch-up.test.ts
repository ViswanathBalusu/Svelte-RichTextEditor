/**
 * The catch-up (HIS-028) at the level of its state: the badge, the order of "for you", the number
 * announced, the marker moving to the head on leaving, and the empty state. The rendered pane, the
 * focus and the live region are checked in a browser run (e2e/his-028-catch-up.spec.ts). The
 * controller is driven with a fake port that keeps a marker which only moves forward, as the service does.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type {
  CatchUpActivity,
  CatchUpForYou,
  CatchUpPort,
  CatchUpResult,
  HistoryChange,
} from '../src/core-api.ts';
import {
  badgeOf,
  createCatchUpController,
  forYouOrder,
  hasActivity,
} from '../src/shell/catch-up.ts';
import { BUILT_IN_PANES, PaneRegistry } from '../src/shell/panes.ts';

const change = (region: string | null, kind = 'modified', user = 'u1'): HistoryChange => ({
  kind,
  blockId: 'b1',
  ...(region === null ? {} : { region }),
  user,
});

const mention: CatchUpForYou = {
  kind: 'mention',
  thread: 't1',
  author: 'u2',
  excerpt: 'Please look',
};
const task: CatchUpForYou = { kind: 'task', thread: 't2', author: null, excerpt: null };

function activity(over: Partial<CatchUpActivity> = {}): CatchUpActivity {
  return {
    marker: 2,
    head: 9,
    changes: [change('r1'), change('r1', 'added'), change(null)],
    comments: 1,
    forYou: [task, mention],
    ...over,
  };
}

/** A port over a server that keeps one marker, only forward, and answers from `head` on. */
function fakePort(
  initial: CatchUpActivity,
  options: { viewed?: boolean; failMark?: boolean } = {},
): { port: CatchUpPort; marked: number[]; loads: number } {
  let marker = initial.marker;
  const marked: number[] = [];
  const out = { port: undefined as unknown as CatchUpPort, marked, loads: 0 };
  out.port = {
    load(): Promise<CatchUpResult> {
      out.loads++;
      // After the marker moved to the head there is nothing newer.
      const seen = marker >= initial.head;
      return Promise.resolve({
        ok: true,
        activity: seen
          ? { ...initial, marker, changes: [], comments: 0, forYou: [] }
          : { ...initial, marker },
      });
    },
    markSeen(seq) {
      marked.push(seq);
      if (options.failMark) return Promise.resolve({ ok: false });
      marker = Math.max(marker, seq);
      return Promise.resolve({ ok: true });
    },
    ...(options.viewed === undefined ? {} : { viewedHead: () => options.viewed === true }),
    resolveUsers: (ids) =>
      Promise.resolve(ids.map((id) => (id === 'u-erased' ? null : { id, name: `Name of ${id}` }))),
  };
  return out;
}

describe('the badge of the catch-up control (HIS-028 criteria 1 and 6)', () => {
  it('counts the changes, the comments of others and the tasks, and shows nothing for no activity', async () => {
    expect(badgeOf(activity())).toBe(3 + 1 + 1);
    expect(badgeOf(activity({ changes: [], comments: 0, forYou: [] }))).toBe(0);
    expect(hasActivity(activity({ changes: [], comments: 0, forYou: [] }))).toBe(false);
    const { port } = fakePort(activity());
    const ctl = createCatchUpController(port);
    expect(ctl.state().badge).toBe(0);
    await ctl.refresh();
    expect(ctl.state()).toMatchObject({ status: 'ready', badge: 5 });
  });

  it('is empty, with no badge and no list, when nothing changed since the marker', async () => {
    const { port } = fakePort(activity({ changes: [], comments: 0, forYou: [] }));
    const ctl = createCatchUpController(port);
    await ctl.refresh();
    expect(ctl.state()).toMatchObject({ status: 'empty', badge: 0, forYou: [], regions: [] });
    expect(ctl.state().announcement).toBeNull();
  });

  it('shows an error when the port fails, and refuses nothing silently', async () => {
    const ctl = createCatchUpController({
      load: () => Promise.reject(new Error('down')),
      markSeen: () => Promise.resolve({ ok: true }),
    });
    await ctl.refresh();
    expect(ctl.state().status).toBe('error');
    const forbidden = createCatchUpController({
      load: () => Promise.resolve({ ok: false, reason: 'forbidden' }),
      markSeen: () => Promise.resolve({ ok: true }),
    });
    await forbidden.refresh();
    expect(forbidden.state().status).toBe('forbidden');
  });
});

describe('the summary per region and the list "for you" (HIS-028 criteria 1 and 2)', () => {
  it('summarises the changes per region, in the order the regions first appear', async () => {
    const { port } = fakePort(activity());
    const ctl = createCatchUpController(port);
    await ctl.refresh();
    expect(ctl.state().regions).toEqual([
      { region: 'r1', count: 2, kinds: { modified: 1, added: 1 } },
      { region: null, count: 1, kinds: { modified: 1 } },
    ]);
  });

  it('lists the mentions first, then the tasks, whatever order the service gave', async () => {
    expect(forYouOrder([task, mention, { ...mention, thread: 't3' }]).map((i) => i.thread)).toEqual(
      ['t1', 't3', 't2'],
    );
    const { port } = fakePort(activity({ forYou: [task, mention] }));
    const ctl = createCatchUpController(port);
    await ctl.refresh();
    expect(ctl.state().forYou.map((i) => i.kind)).toEqual(['mention', 'task']);
  });

  it('names the people with the host directory, and an erased person as unknown (null)', async () => {
    const { port } = fakePort(
      activity({ changes: [change('r1', 'modified', 'u-erased'), change('r1')] }),
    );
    const ctl = createCatchUpController(port);
    await ctl.refresh();
    const names = ctl.state().names;
    expect(names.get('u-erased')).toBeNull();
    expect(names.get('u1')).toBe('Name of u1');
    expect(names.get('u2')).toBe('Name of u2');
  });
});

describe('the announcement (HIS-028 criterion 5, state part)', () => {
  it('gives the number of changes once for each load that finds activity', async () => {
    const { port } = fakePort(activity());
    const ctl = createCatchUpController(port);
    await ctl.refresh();
    expect(ctl.state().announcement).toEqual({ changes: 3, n: 1 });
    await ctl.refresh();
    expect(ctl.state().announcement).toEqual({ changes: 3, n: 2 });
  });
});

describe('leaving or dismissing moves the marker to the head (HIS-028 criterion 4)', () => {
  it('moves the marker to the head, and a later visit shows only newer activity', async () => {
    const fake = fakePort(activity());
    const first = createCatchUpController(fake.port);
    await first.refresh();
    expect(await first.finish()).toBe(true);
    expect(fake.marked).toEqual([9]);
    expect(first.state()).toMatchObject({ status: 'empty', badge: 0 });
    // A later visit, as a new controller does it: nothing is newer than the head.
    const later = createCatchUpController(fake.port);
    await later.refresh();
    expect(later.state()).toMatchObject({ status: 'empty', badge: 0 });
    expect(fake.marked).toEqual([9]);
  });

  it('does not move the marker when the user has not viewed the head', async () => {
    const fake = fakePort(activity(), { viewed: false });
    const ctl = createCatchUpController(fake.port);
    await ctl.refresh();
    expect(await ctl.finish()).toBe(false);
    expect(fake.marked).toEqual([]);
    expect(ctl.state().status).toBe('ready');
  });

  it('keeps the activity and says so when the marker could not be moved', async () => {
    const fake = fakePort(activity(), { failMark: true });
    const ctl = createCatchUpController(fake.port);
    await ctl.refresh();
    expect(await ctl.finish()).toBe(false);
    expect(ctl.state()).toMatchObject({ status: 'ready', markFailed: true, badge: 5 });
  });

  it('moves nothing when there is no activity to leave', async () => {
    const fake = fakePort(activity({ marker: 9, changes: [], comments: 0, forYou: [] }));
    const ctl = createCatchUpController(fake.port);
    await ctl.refresh();
    expect(await ctl.finish()).toBe(false);
    expect(fake.marked).toEqual([]);
  });

  it('asks again when the host says there may be news', async () => {
    let tell: () => void = () => undefined;
    const fake = fakePort(activity());
    const port: CatchUpPort = { ...fake.port, onChange: (l) => ((tell = l), () => undefined) };
    const ctl = createCatchUpController(port);
    await ctl.refresh();
    const before = fake.loads;
    tell();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.loads).toBe(before + 1);
  });
});

describe('the pane is offered only with the port (HIS-028)', () => {
  it('is in the registry with a loader, and offered when the core has a catch-up port', () => {
    const reg = new PaneRegistry(BUILT_IN_PANES);
    const descriptor = reg.get('catch-up');
    expect(descriptor?.load).toBeTypeOf('function');
    const offered = (core: object) => reg.offered('catch-up', core as never, ['history']);
    expect(offered({})).toBe(false);
    expect(offered({ catchUp: { load: () => undefined } })).toBe(true);
  });

  it('is reached only through its dynamic import, so it stays out of the first load (02 §2)', () => {
    const panes = readFileSync(new URL('../src/shell/panes.ts', import.meta.url), 'utf8');
    expect(panes).toMatch(/import\('\.\.\/panes\/CatchUpPane\.svelte'\)/);
    const app = readFileSync(new URL('../src/App.svelte', import.meta.url), 'utf8');
    expect(app).not.toMatch(/from '\.\/panes\/CatchUpPane\.svelte'/);
  });
});
