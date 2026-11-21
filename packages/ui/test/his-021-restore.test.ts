/**
 * Restoring from the history pane (HIS-021 criterion 4), at the level of its rules and its
 * controller: the dry run is asked for first and shown with the comparison view over the open
 * version, and the real restore can only follow a confirmed preview of the same request. Refusals,
 * cancelling, late replies and what the user may restore are covered here; the drawn pane (the
 * controls, the words, focus) is checked in the browser run (`e2e/his-021-restore.spec.ts`).
 */
import { describe, expect, it } from 'vitest';
import type {
  HistoryChange,
  HistoryComparison,
  HistoryPaneItem,
  HistoryPort,
  HistoryRestorePreviewResult,
  HistoryRestoreRefusal,
  HistoryRestoreRequest,
  HistoryRestoreResult,
  HistoryRestoreScopes,
  HistoryVersionView,
} from '../src/core-api.ts';
import { CURRENT_KEY, createCompareController } from '../src/shell/history-compare.ts';
import { createHistoryController } from '../src/shell/history-pane.ts';
import { createRestoreController, restoreTargets } from '../src/shell/history-restore.ts';

const named: HistoryPaneItem = {
  kind: 'version',
  id: 'v1',
  name: 'Board draft',
  note: null,
  creator: 'u1',
  time: '2026-11-13T10:00:00Z',
  seq: 12,
};

const group: HistoryPaneItem = {
  kind: 'group',
  id: 'g1',
  day: '2026-11-13',
  from: '2026-11-13T09:00:00Z',
  to: '2026-11-13T09:04:00Z',
  authors: ['u1'],
  changes: 2,
  origins: ['input'],
  toSeq: 8,
};

/** The dry run of the harness: from the head (30) to the commit the restore would add (31). */
const CHANGES: HistoryChange[] = [
  {
    kind: 'modified',
    blockId: 'pA',
    region: 'r1',
    user: 'u1',
    spans: [{ op: 'insert', at: 0, text: 'old words', user: 'u1' }],
  },
  { kind: 'removed', blockId: 'pNew', region: 'r1' },
  { kind: 'field', fieldId: 'f1', blockId: 'pB', user: 'u2' },
];

const DRY_RUN: HistoryComparison = { fromSeq: 30, toSeq: 31, changes: CHANGES };

interface Drawn {
  /** Every list of changes a view was told to draw, in order; an empty one removes the marks. */
  shown: (readonly HistoryChange[])[];
  closed: number;
}

interface Options {
  preview?: (request: HistoryRestoreRequest) => Promise<HistoryRestorePreviewResult>;
  restore?: (request: HistoryRestoreRequest & { headSeq: number }) => Promise<HistoryRestoreResult>;
  scopes?: () => Promise<HistoryRestoreScopes>;
  /** Leave out a method of the port. */
  without?: 'previewRestore' | 'restore' | 'openVersion';
}

const previewOk = (
  over: Partial<{ headSeq: number; unchanged: boolean; comparison: HistoryComparison }> = {},
): Promise<HistoryRestorePreviewResult> =>
  Promise.resolve({
    ok: true,
    preview: { headSeq: 30, unchanged: false, comparison: DRY_RUN, ...over },
  });

function harness(options: Options = {}) {
  const drawn: Drawn = { shown: [], closed: 0 };
  const previews: HistoryRestoreRequest[] = [];
  const restores: (HistoryRestoreRequest & { headSeq: number })[] = [];
  const opened: number[] = [];
  let lists = 0;
  const port: HistoryPort = {
    list: () => {
      lists++;
      return Promise.resolve({ items: [group, named], nextCursor: null, namedOnly: false });
    },
    choices: () =>
      Promise.resolve({
        regions: [
          { id: 'r1', label: 'Terms' },
          { id: 'r2', label: 'Notes' },
        ],
        fields: [],
        people: [],
      }),
    resolveUsers: ((ids: readonly string[]) =>
      Promise.resolve(ids.map((id) => ({ id, name: `Name ${id}` })))) as never,
    ...(options.without === 'openVersion'
      ? {}
      : {
          openVersion: (seq: number, label: { time: string; name: string | null }) => {
            opened.push(seq);
            const view: HistoryVersionView = {
              seq,
              time: label.time,
              name: label.name,
              mount: () => () => undefined,
              showComparison: (changes) => {
                drawn.shown.push(changes);
              },
              showDeletions: () => undefined,
              focusChange: () => true,
              close: () => {
                drawn.closed++;
              },
            };
            return Promise.resolve({ ok: true as const, view });
          },
        }),
    ...(options.without === 'previewRestore'
      ? {}
      : {
          previewRestore: (request: HistoryRestoreRequest) => {
            previews.push(request);
            return (options.preview ?? (() => previewOk()))(request);
          },
        }),
    ...(options.without === 'restore'
      ? {}
      : {
          restore: (request: HistoryRestoreRequest & { headSeq: number }) => {
            restores.push(request);
            return (options.restore ?? (() => Promise.resolve({ ok: true as const, seq: 31 })))(
              request,
            );
          },
        }),
    ...(options.scopes ? { restoreScopes: options.scopes } : {}),
  };
  const history = createHistoryController(port);
  const compare = createCompareController(port, history);
  const restore = createRestoreController(port, history, compare);
  return {
    port,
    history,
    compare,
    restore,
    drawn,
    previews,
    restores,
    opened,
    lists: () => lists,
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('what the pane offers to restore (HIS-021 criterion 4; 07 §13)', () => {
  const regions = [
    { id: 'r1', label: 'Terms' },
    { id: 'r2', label: 'Notes' },
  ];

  it('offers the whole document and every region when the host does not say', () => {
    expect(restoreTargets(null, regions)).toEqual([
      { key: 'document', region: null, label: null },
      { key: 'region:r1', region: 'r1', label: 'Terms' },
      { key: 'region:r2', region: 'r2', label: 'Notes' },
    ]);
  });

  it('offers only what the user may restore', () => {
    expect(restoreTargets({ document: false, regions: ['r2'] }, regions)).toEqual([
      { key: 'region:r2', region: 'r2', label: 'Notes' },
    ]);
    expect(restoreTargets({ document: true, regions: [] }, regions)).toEqual([
      { key: 'document', region: null, label: null },
    ]);
    // A region the host names but the list does not show is not offered.
    expect(restoreTargets({ document: false, regions: ['r9'] }, regions)).toEqual([]);
    expect(restoreTargets({ document: false, regions: [] }, regions)).toEqual([]);
  });

  it('reads the scopes from the host, and offers everything when the host cannot say', async () => {
    const told = harness({ scopes: () => Promise.resolve({ document: false, regions: ['r1'] }) });
    expect(told.restore.state().scopes).toBeNull();
    await flush();
    expect(told.restore.state().scopes).toEqual({ document: false, regions: ['r1'] });
    const failing = harness({ scopes: () => Promise.reject(new Error('offline')) });
    await flush();
    expect(failing.restore.state().scopes).toBeNull();
  });

  it('offers a restore only when the host gives the dry run, the restore and old versions', () => {
    expect(harness().restore.offered).toBe(true);
    for (const without of ['previewRestore', 'restore', 'openVersion'] as const)
      expect(harness({ without }).restore.offered, without).toBe(false);
  });
});

describe('the dry run comes first and is shown with the comparison view (HIS-021 criterion 4)', () => {
  it('asks for the dry run of the open version and draws it over that version', async () => {
    const h = harness();
    await h.history.reload();
    await h.history.open(named);
    expect(await h.restore.preview(null)).toBe(true);
    expect(h.previews).toEqual([{ toSeq: 12, region: null }]);
    // Nothing was restored by asking.
    expect(h.restores).toEqual([]);
    expect(h.restore.state()).toMatchObject({
      status: 'preview',
      request: { toSeq: 12, region: null },
      headSeq: 30,
      unchanged: false,
      changes: 3,
      step: null,
      reason: null,
    });
    // The comparison view: the same state the comparison of two versions uses, over the open
    // version (the document the restore would leave), with its navigator and names.
    expect(h.opened).toEqual([12]);
    expect(h.drawn.shown).toEqual([CHANGES]);
    const c = h.compare.state();
    expect(c).toMatchObject({ status: 'ready', fromSeq: 30, toSeq: 31, index: -1 });
    expect(c.rows.map((r) => r.change.kind)).toEqual(['modified', 'removed', 'field']);
    expect(c.names.get('u2')).toBe('Name u2');
    expect(h.compare.next()).toBe(true);
    expect(h.compare.state().index).toBe(0);
    // The version is still open and read-only; the list is as it was.
    expect(h.history.state().viewing?.status).toBe('open');
    expect(h.lists()).toBe(1);
  });

  it('asks for one region when one is chosen', async () => {
    const h = harness();
    await h.history.reload();
    await h.history.open(group);
    expect(await h.restore.preview('r1')).toBe(true);
    expect(h.previews).toEqual([{ toSeq: 8, region: 'r1' }]);
    expect(h.restore.state().request).toEqual({ toSeq: 8, region: 'r1' });
  });

  it('carries the definitions a restore would bring back or replace (HIS-020)', async () => {
    const h = harness({
      preview: () =>
        Promise.resolve({
          ok: true,
          preview: {
            headSeq: 30,
            unchanged: false,
            comparison: DRY_RUN,
            recreated: ['style_def/LegalQuote'],
            replaced: ['style_def/Old'],
          },
        }),
    });
    await h.history.open(named);
    await h.restore.preview(null);
    expect(h.restore.state()).toMatchObject({
      recreated: ['style_def/LegalQuote'],
      replaced: ['style_def/Old'],
    });
  });

  it('does nothing without an open version', async () => {
    const h = harness();
    await h.history.reload();
    expect(await h.restore.preview(null)).toBe(false);
    expect(h.previews).toEqual([]);
    expect(h.restore.state().status).toBe('idle');
  });

  it('does not restore to the current document, which a comparison opens as its newer end', async () => {
    const h = harness();
    // As the comparison controller opens it: the head, under the key of the current document.
    await h.history.openAt(CURRENT_KEY, { seq: 30, time: '2026-11-14T09:00:00Z', name: null });
    expect(h.history.state().viewing?.status).toBe('open');
    expect(await h.restore.preview(null)).toBe(false);
    expect(h.previews).toEqual([]);
    expect(h.restore.state().status).toBe('idle');
  });

  it('replaces the marks of an earlier comparison or preview', async () => {
    const h = harness();
    await h.history.open(named);
    await h.restore.preview(null);
    await h.restore.preview('r2');
    // The first preview's marks were removed (an empty list) before the second was drawn.
    expect(h.drawn.shown).toEqual([CHANGES, [], CHANGES]);
    expect(h.restore.state().request).toEqual({ toSeq: 12, region: 'r2' });
  });
});

describe('the real restore only follows a confirmed preview (HIS-021 criterion 4)', () => {
  it('restores the request of the preview, with its head, then closes the version and reloads the list', async () => {
    const h = harness();
    await h.history.reload();
    await h.history.open(named);
    await h.restore.preview('r1');
    expect(h.restores).toEqual([]);
    expect(await h.restore.confirm()).toBe(true);
    expect(h.restores).toEqual([{ toSeq: 12, region: 'r1', headSeq: 30 }]);
    expect(h.restore.state()).toMatchObject({
      status: 'done',
      restored: { seq: 31, toSeq: 12, region: 'r1' },
      request: null,
    });
    // Back at the list, which was asked for again; the read-only version is released once.
    expect(h.history.state().viewing).toBeNull();
    expect(h.drawn.closed).toBe(1);
    expect(h.lists()).toBe(2);
    expect(h.compare.state().status).toBe('idle');
    // A second confirmation has no preview to stand on.
    expect(await h.restore.confirm()).toBe(false);
    expect(h.restores).toHaveLength(1);
  });

  it('never calls the restore without a preview that is shown', async () => {
    const waiting: (() => void)[] = [];
    const h = harness({
      preview: () =>
        new Promise<HistoryRestorePreviewResult>((resolve) =>
          waiting.push(() => void previewOk().then(resolve)),
        ),
    });
    await h.history.reload();
    // No version open, and no preview asked for.
    expect(await h.restore.confirm()).toBe(false);
    await h.history.open(named);
    expect(await h.restore.confirm()).toBe(false);
    // While the dry run is being computed.
    const pending = h.restore.preview(null);
    await flush();
    expect(h.restore.state().status).toBe('previewing');
    expect(await h.restore.confirm()).toBe(false);
    waiting[0]?.();
    expect(await pending).toBe(true);
    // After the user cancelled the preview.
    h.restore.cancel();
    expect(h.restore.state().status).toBe('idle');
    expect(await h.restore.confirm()).toBe(false);
    expect(h.restores).toEqual([]);
  });

  it('does not restore from a preview of a version that is no longer open', async () => {
    const h = harness();
    await h.history.reload();
    await h.history.open(named);
    await h.restore.preview(null);
    // Another version is opened without the pane telling the controller.
    await h.history.open(group);
    expect(await h.restore.confirm()).toBe(false);
    expect(h.restores).toEqual([]);
    expect(h.restore.state().status).toBe('idle');
  });

  it('does not let a preview that changes nothing be confirmed', async () => {
    const h = harness({
      preview: () =>
        previewOk({ unchanged: true, comparison: { fromSeq: 30, toSeq: 31, changes: [] } }),
    });
    await h.history.open(named);
    expect(await h.restore.preview(null)).toBe(true);
    expect(h.restore.state()).toMatchObject({ status: 'preview', unchanged: true, changes: 0 });
    expect(await h.restore.confirm()).toBe(false);
    expect(h.restores).toEqual([]);
  });

  it('ignores a second confirmation while the first is in flight', async () => {
    let answer!: (r: HistoryRestoreResult) => void;
    const h = harness({
      restore: () => new Promise<HistoryRestoreResult>((resolve) => (answer = resolve)),
    });
    await h.history.open(named);
    await h.restore.preview(null);
    const first = h.restore.confirm();
    await flush();
    expect(h.restore.state().status).toBe('restoring');
    expect(await h.restore.confirm()).toBe(false);
    // Nor can it be cancelled, reset or previewed again: the answer is waited for.
    h.restore.cancel();
    h.restore.reset();
    expect(await h.restore.preview(null)).toBe(false);
    expect(h.restore.state().status).toBe('restoring');
    answer({ ok: true, seq: 31 });
    expect(await first).toBe(true);
    expect(h.restores).toHaveLength(1);
    expect(h.restore.state().status).toBe('done');
  });
});

describe('refusals, cancelling and late replies (HIS-021 criterion 4)', () => {
  const REASONS: HistoryRestoreRefusal[] = [
    'forbidden',
    'not_found',
    'conflict',
    'workflow_active',
    'too_large',
    'failed',
  ];

  it('says why a dry run was refused, draws nothing and offers no confirmation', async () => {
    for (const reason of REASONS) {
      const h = harness({ preview: () => Promise.resolve({ ok: false, reason }) });
      await h.history.open(named);
      expect(await h.restore.preview(null)).toBe(false);
      expect(h.restore.state()).toMatchObject({ status: 'refused', step: 'preview', reason });
      expect(h.drawn.shown).toEqual([]);
      expect(h.compare.state().status).toBe('idle');
      expect(await h.restore.confirm()).toBe(false);
      expect(h.restores).toEqual([]);
      // The version the user was reading is still open.
      expect(h.history.state().viewing?.status).toBe('open');
    }
    const h = harness({ preview: () => Promise.reject(new Error('network')) });
    await h.history.open(named);
    await h.restore.preview(null);
    expect(h.restore.state()).toMatchObject({
      status: 'refused',
      step: 'preview',
      reason: 'failed',
    });
  });

  it('says why a restore was refused, removes the preview and lets the user preview again', async () => {
    const answers: HistoryRestoreResult[] = [
      { ok: false, reason: 'conflict' },
      { ok: true, seq: 33 },
    ];
    const h = harness({ restore: () => Promise.resolve(answers.shift()!) });
    await h.history.reload();
    await h.history.open(named);
    await h.restore.preview(null);
    expect(await h.restore.confirm()).toBe(false);
    expect(h.restore.state()).toMatchObject({
      status: 'refused',
      step: 'restore',
      reason: 'conflict',
      request: { toSeq: 12, region: null },
    });
    // The marks are gone (the preview no longer stands), the version stays, the list is not reloaded.
    expect(h.drawn.shown).toEqual([CHANGES, []]);
    expect(h.compare.state().status).toBe('idle');
    expect(h.history.state().viewing?.status).toBe('open');
    expect(h.lists()).toBe(1);
    // A refused restore is not a preview: it cannot be confirmed again without a new dry run.
    expect(await h.restore.confirm()).toBe(false);
    expect(h.restores).toHaveLength(1);
    expect(await h.restore.preview(null)).toBe(true);
    expect(await h.restore.confirm()).toBe(true);
    expect(h.restores).toHaveLength(2);
    expect(h.restore.state()).toMatchObject({ status: 'done', restored: { seq: 33 } });

    const failing = harness({ restore: () => Promise.reject(new Error('network')) });
    await failing.history.open(named);
    await failing.restore.preview(null);
    await failing.restore.confirm();
    expect(failing.restore.state()).toMatchObject({
      status: 'refused',
      step: 'restore',
      reason: 'failed',
    });
  });

  it('cancels a preview: the marks go, the version stays, nothing is restored', async () => {
    const h = harness();
    await h.history.open(named);
    await h.restore.preview(null);
    h.restore.cancel();
    expect(h.restore.state()).toMatchObject({ status: 'idle', request: null, headSeq: null });
    expect(h.drawn.shown).toEqual([CHANGES, []]);
    expect(h.compare.state().status).toBe('idle');
    expect(h.history.state().viewing?.status).toBe('open');
    expect(h.drawn.closed).toBe(0);
    expect(h.restores).toEqual([]);
    // Cancelling again, or with nothing to cancel, changes nothing.
    h.restore.cancel();
    expect(h.drawn.shown).toEqual([CHANGES, []]);
  });

  it('drops a dry run that answers after the user cancelled, left or asked again', async () => {
    const waiting: (() => void)[] = [];
    const h = harness({
      preview: () =>
        new Promise<HistoryRestorePreviewResult>((resolve) =>
          waiting.push(() => void previewOk().then(resolve)),
        ),
    });
    await h.history.open(named);
    // Cancelled while it was computed.
    const cancelled = h.restore.preview(null);
    await flush();
    h.restore.cancel();
    waiting[0]?.();
    expect(await cancelled).toBe(false);
    expect(h.restore.state().status).toBe('idle');
    expect(h.drawn.shown).toEqual([]);

    // Asked twice: only the later request is shown, even when the earlier one answers last.
    const first = h.restore.preview(null);
    await flush();
    const second = h.restore.preview('r1');
    await flush();
    waiting[2]?.();
    expect(await second).toBe(true);
    waiting[1]?.();
    expect(await first).toBe(false);
    expect(h.restore.state().request).toEqual({ toSeq: 12, region: 'r1' });
    expect(h.drawn.shown).toEqual([CHANGES]);

    // The user leaves the version while a dry run is computed: nothing is drawn or kept.
    h.restore.cancel();
    const left = h.restore.preview(null);
    await flush();
    h.history.leave();
    waiting[3]?.();
    expect(await left).toBe(false);
    expect(h.restore.state().status).toBe('idle');
    expect(await h.restore.confirm()).toBe(false);
    expect(h.restores).toEqual([]);
  });

  it('forgets a preview when the version changes, and keeps the word of a finished restore', async () => {
    const h = harness();
    await h.history.reload();
    await h.history.open(named);
    await h.restore.preview(null);
    h.restore.reset();
    expect(h.restore.state().status).toBe('idle');
    expect(await h.restore.confirm()).toBe(false);

    await h.restore.preview(null);
    await h.restore.confirm();
    expect(h.restore.state().status).toBe('done');
    // The pane resets the controller whenever the open version changes: the message stays.
    h.restore.reset();
    h.restore.cancel();
    expect(h.restore.state()).toMatchObject({ status: 'done', restored: { seq: 31 } });
    // The next preview starts afresh.
    await h.history.open(group);
    await h.restore.preview(null);
    expect(h.restore.state()).toMatchObject({ status: 'preview', restored: null });
  });

  it('keeps the answer of a restore that was sent, whatever else happens in the pane', async () => {
    let answer!: (r: HistoryRestoreResult) => void;
    const h = harness({
      restore: () => new Promise<HistoryRestoreResult>((resolve) => (answer = resolve)),
    });
    await h.history.reload();
    await h.history.open(named);
    await h.restore.preview(null);
    const sent = h.restore.confirm();
    await flush();
    h.restore.reset();
    answer({ ok: true, seq: 31 });
    expect(await sent).toBe(true);
    expect(h.restore.state()).toMatchObject({ status: 'done', restored: { seq: 31 } });
    expect(h.lists()).toBe(2);
  });

  it('changes nothing after the pane closed', async () => {
    let answer!: (r: HistoryRestoreResult) => void;
    const h = harness({
      restore: () => new Promise<HistoryRestoreResult>((resolve) => (answer = resolve)),
    });
    await h.history.reload();
    await h.history.open(named);
    await h.restore.preview(null);
    let notified = 0;
    h.restore.subscribe(() => notified++);
    const sent = h.restore.confirm();
    await flush();
    // The pane closes: it disposes the restore controller, then the history controller.
    h.restore.dispose();
    h.history.dispose();
    const before = notified;
    answer({ ok: true, seq: 31 });
    expect(await sent).toBe(true);
    expect(notified).toBe(before);
    // The version was released once, by the pane; the list was not asked for again.
    expect(h.drawn.closed).toBe(1);
    expect(h.lists()).toBe(1);
  });
});

describe('showing a held comparison over the open version (HIS-021; HIS-013)', () => {
  it('draws it, lists it and resolves its names; without a version it does nothing', async () => {
    const h = harness();
    expect(await h.compare.show(DRY_RUN)).toBe(false);
    expect(h.compare.state().status).toBe('idle');
    await h.history.open(named);
    expect(await h.compare.show(DRY_RUN)).toBe(true);
    expect(h.drawn.shown).toEqual([CHANGES]);
    expect(h.compare.state()).toMatchObject({ status: 'ready', fromSeq: 30, toSeq: 31 });
    expect(h.compare.state().names.get('u1')).toBe('Name u1');
  });

  it('removes the marks and keeps the version when cleared', async () => {
    const h = harness();
    await h.history.open(named);
    await h.compare.show(DRY_RUN);
    h.compare.setShowDeleted(true);
    h.compare.clear();
    expect(h.drawn.shown).toEqual([CHANGES, []]);
    expect(h.compare.state()).toMatchObject({ status: 'idle', rows: [], showDeleted: true });
    expect(h.history.state().viewing?.status).toBe('open');
    expect(h.drawn.closed).toBe(0);
    // Clearing when nothing is shown draws nothing.
    h.compare.clear();
    expect(h.drawn.shown).toEqual([CHANGES, []]);
  });

  it('does not draw on a version the user has left meanwhile', async () => {
    let release!: () => void;
    const h = harness();
    const slowNames = new Promise<void>((resolve) => (release = resolve));
    (h.port as { resolveUsers: unknown }).resolveUsers = async (ids: readonly string[]) => {
      await slowNames;
      return ids.map((id) => ({ id, name: `Name ${id}` }));
    };
    const h2 = {
      history: createHistoryController(h.port),
    };
    const compare = createCompareController(h.port, h2.history);
    await h2.history.open(named);
    const shown = compare.show(DRY_RUN);
    await flush();
    h2.history.leave();
    release();
    expect(await shown).toBe(false);
    expect(h.drawn.shown).toEqual([]);
  });
});
