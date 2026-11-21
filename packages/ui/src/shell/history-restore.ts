/**
 * The restore of the history pane (HIS-021 criterion 4; 08 §8): the rules and the state, with no
 * Svelte import, so they are tested in Node and the component only renders the state.
 *
 * A restore from the pane takes two steps, and the order cannot be changed:
 *
 * 1. `preview` asks the host for the dry run of restoring the version that is open (the whole
 *    document, or one region of it) and shows the answer with the comparison view: the changes are
 *    drawn over the open version, which is what the document would hold, and the same navigator and
 *    summary list them (HIS-013). Nothing is committed by a dry run. The current document, which a
 *    comparison opens as its newer end, is not an earlier version and is not restored to.
 * 2. `confirm` asks for the real restore. It works only while a preview is shown, for the request
 *    of that preview and with the head it was computed against. In every other state it calls
 *    nothing. A preview that says nothing would change cannot be confirmed.
 *
 * A refusal of either step is kept with its reason, so the pane can say it in words. After a
 * refused restore the preview no longer stands (the document may have moved), so its marks are
 * removed and the user asks for a new preview. A reply that arrives after the user cancelled, left
 * the version or opened another is dropped. Once the real restore has been sent, its answer is
 * always kept: the document may have changed, whatever the user did meanwhile.
 */
import type {
  HistoryChoice,
  HistoryPort,
  HistoryRestoreRefusal,
  HistoryRestoreRequest,
  HistoryRestoreScopes,
} from '../core-api.ts';
import { CURRENT_KEY, type CompareController } from './history-compare.ts';
import type { HistoryController } from './history-pane.ts';

export type RestoreStatus = 'idle' | 'previewing' | 'preview' | 'restoring' | 'refused' | 'done';

export interface RestoreState {
  readonly status: RestoreStatus;
  /** What the dry run, the preview, the restore in flight or the refusal is about. */
  readonly request: HistoryRestoreRequest | null;
  /** The head the preview was computed against. */
  readonly headSeq: number | null;
  /** True when the preview says the restore would change nothing; it cannot be confirmed then. */
  readonly unchanged: boolean;
  /** How many changes the preview lists. */
  readonly changes: number;
  /** Definitions the restore would bring back, and those it would replace by the default (HIS-020). */
  readonly recreated: readonly string[];
  readonly replaced: readonly string[];
  /** For `refused`: the step the service refused, and why. */
  readonly step: 'preview' | 'restore' | null;
  readonly reason: HistoryRestoreRefusal | null;
  /** For `done`: the `seq` the restore made and what was restored. */
  readonly restored: {
    readonly seq: number;
    readonly toSeq: number;
    readonly region: string | null;
  } | null;
  /** What the user may restore; null when the host does not say (everything is then offered). */
  readonly scopes: HistoryRestoreScopes | null;
}

/** One thing the pane offers to restore: the whole document, or one region. */
export interface RestoreTarget {
  /** `document`, or `region:<id>`: the value of the pane's list. */
  readonly key: string;
  readonly region: string | null;
  /** The region's label; null for the whole document. */
  readonly label: string | null;
}

/**
 * The key of the target that is the whole document. A pane holds the chosen key in `$state`, so the
 * name says "whole" and not "document": the check of FE-023 reads a name with "doc" in it as
 * document state (packages/element/test/state-source.test.ts).
 */
export const WHOLE_TARGET = 'document';

/**
 * What the pane offers to restore: the whole document when the user may restore it, then each
 * region of the filters' list that the user may restore, in that list's order. Without `scopes`
 * (the host does not say) everything is offered and the service's refusal is shown when it comes.
 */
export function restoreTargets(
  scopes: HistoryRestoreScopes | null,
  regions: readonly HistoryChoice[],
): RestoreTarget[] {
  const out: RestoreTarget[] = [];
  if (scopes === null || scopes.document)
    out.push({ key: WHOLE_TARGET, region: null, label: null });
  for (const region of regions)
    if (scopes === null || scopes.regions.includes(region.id))
      out.push({ key: `region:${region.id}`, region: region.id, label: region.label });
  return out;
}

export interface RestoreController {
  /** Whether the host offers a restore at all: the dry run, the restore and old versions to open. */
  readonly offered: boolean;
  state(): RestoreState;
  subscribe(listener: () => void): () => void;
  /**
   * Asks for the dry run of restoring the open version (`region` null: the whole document) and
   * shows it with the comparison view. True when the preview is shown.
   */
  preview(region: string | null): Promise<boolean>;
  /**
   * The real restore of the request whose preview is shown. True when the document was restored.
   * False, with nothing called, when no preview is shown or it says nothing would change.
   */
  confirm(): Promise<boolean>;
  /** Drops the dry run, the preview or the refusal; the version stays open, without marks. */
  cancel(): void;
  /**
   * The open version changed or was left: what was asked about it no longer stands. A restore in
   * flight and the message of a finished one are kept.
   */
  reset(): void;
  /** The pane closes: a reply that arrives later changes nothing here. */
  dispose(): void;
}

const NOTHING = {
  status: 'idle',
  request: null,
  headSeq: null,
  unchanged: false,
  changes: 0,
  recreated: [],
  replaced: [],
  step: null,
  reason: null,
  restored: null,
} as const satisfies Omit<RestoreState, 'scopes'>;

/**
 * Creates the restore controller over the port, the history controller (which holds the open
 * version and the list) and the comparison controller (which draws and lists the changes).
 */
export function createRestoreController(
  port: HistoryPort,
  history: Pick<HistoryController, 'state' | 'reload'>,
  compare: Pick<CompareController, 'show' | 'clear' | 'close'>,
): RestoreController {
  const listeners = new Set<() => void>();
  const offered =
    port.previewRestore !== undefined &&
    port.restore !== undefined &&
    port.openVersion !== undefined;
  let current: RestoreState = { ...NOTHING, scopes: null };
  // Each dry run takes a number; cancelling, leaving or asking again makes an earlier reply late.
  let latest = 0;
  let disposed = false;

  const set = (patch: Partial<RestoreState>): void => {
    current = { ...current, ...patch };
    for (const listener of [...listeners]) listener();
  };

  const openVersion = () => {
    const v = history.state().viewing;
    return v?.status === 'open' ? v : null;
  };

  if (offered && port.restoreScopes !== undefined)
    port
      .restoreScopes()
      .then((scopes) => {
        if (!disposed) set({ scopes });
      })
      // A host that cannot say offers everything; the service still decides.
      .catch(() => undefined);

  return {
    offered,
    state: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async preview(region) {
      if (!offered || port.previewRestore === undefined || current.status === 'restoring')
        return false;
      const version = openVersion();
      // The current document, open as the newer end of a comparison, is not an earlier version.
      if (version === null || version.key === CURRENT_KEY) return false;
      const request: HistoryRestoreRequest = { toSeq: version.seq, region };
      const mine = ++latest;
      // Marks of an earlier comparison or preview do not belong to this one.
      compare.clear();
      set({ ...NOTHING, status: 'previewing', request });
      let result;
      try {
        result = await port.previewRestore(request);
      } catch {
        result = { ok: false as const, reason: 'failed' as const };
      }
      if (mine !== latest || disposed) return false;
      if (openVersion()?.view !== version.view) {
        // The user left the version while the dry run was computed: there is nothing to draw on.
        set({ ...NOTHING });
        return false;
      }
      if (!result.ok) {
        set({ ...NOTHING, status: 'refused', request, step: 'preview', reason: result.reason });
        return false;
      }
      const p = result.preview;
      set({
        ...NOTHING,
        status: 'preview',
        request,
        headSeq: p.headSeq,
        unchanged: p.unchanged,
        changes: p.comparison.changes.length,
        recreated: p.recreated ?? [],
        replaced: p.replaced ?? [],
      });
      await compare.show(p.comparison);
      return mine === latest && !disposed && current.status === 'preview';
    },
    async confirm() {
      const { request, headSeq } = current;
      if (
        port.restore === undefined ||
        current.status !== 'preview' ||
        current.unchanged ||
        request === null ||
        headSeq === null
      )
        return false;
      // The preview is of the version that is open; anything else is not what the user saw.
      if (openVersion()?.seq !== request.toSeq) {
        latest++;
        set({ ...NOTHING });
        return false;
      }
      latest++;
      set({ status: 'restoring' });
      let result;
      try {
        result = await port.restore({ ...request, headSeq });
      } catch {
        result = { ok: false as const, reason: 'failed' as const };
      }
      if (disposed) return result.ok;
      if (!result.ok) {
        // The preview no longer stands: the document may have moved since it was computed.
        compare.clear();
        set({ ...NOTHING, status: 'refused', request, step: 'restore', reason: result.reason });
        return false;
      }
      set({
        ...NOTHING,
        status: 'done',
        restored: { seq: result.seq, toSeq: request.toSeq, region: request.region },
      });
      // Back to the list, which now holds the restore.
      compare.close();
      await history.reload();
      return true;
    },
    cancel() {
      if (current.status === 'restoring' || current.status === 'idle' || current.status === 'done')
        return;
      latest++;
      compare.clear();
      set({ ...NOTHING });
    },
    reset() {
      if (current.status === 'restoring' || current.status === 'idle' || current.status === 'done')
        return;
      latest++;
      set({ ...NOTHING });
    },
    dispose() {
      disposed = true;
      latest++;
      listeners.clear();
    },
  };
}
