/**
 * FE-027 criterion 6: content leaves the editor only through the explicit method. The element's
 * events (`de-selection`, `de-command-state`, `de-status`, `de-change`, `de-permission-change`,
 * `de-error`, ...) are derived from the core's read views, so this checks that no read view holds
 * document text once the text has been typed, while `getSelectionContent()` still returns it.
 *
 * The `outline` view is left out on purpose: it lists the headings for the shell's navigation pane,
 * not an event, and it is not part of the embedding API's events (05 §8.1).
 */
import type { Node } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { SPIKE_IDS, spikeDocument } from './fixtures.ts';
import { microtask, posOf } from './support.ts';

const SENTINEL = 'ZQX-SENTINEL-7731';

/** Lets the view hub's pending notification pass run (it is scheduled as a microtask). */
const flush = (): Promise<void> => new Promise<void>((done) => setTimeout(done, 0));

interface ReadLike {
  get(): unknown;
  subscribe(listener: () => void): () => void;
}

/** The read views the element turns into events or status, with the core's names. */
function eventViews(core: DocumentCore): Record<string, ReadLike> {
  return {
    selection: core.selection,
    panel: core.panel,
    permissions: core.permissions,
    access: core.access,
    saveState: core.saveState,
    confirmedSeq: core.confirmedSeq,
    connection: core.connection,
    status: core.status,
    commands: core.commands,
    revision: core.revision,
    direction: core.direction,
    refusal: core.refusal,
    mode: core.mode,
    trimmed: core.trimmed,
    recovered: core.recovered,
    syncSummary: core.syncSummary,
    presence: core.presence,
    features: core.features,
    counts: core.counts,
    problem: core.problem,
    findState: core.findState,
  };
}

/** The document range of the first text node that holds the sentinel, or null. */
function sentinelRange(doc: Node): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.isText && node.text !== undefined && node.text.includes(SENTINEL)) {
      const from = pos + node.text.indexOf(SENTINEL);
      found = { from, to: from + SENTINEL.length };
      return false;
    }
    return true;
  });
  return found;
}

describe('FE-027 criterion 6: content leaves the editor only by the explicit method', () => {
  it('no read view that feeds an event carries the typed text, and the explicit method still does', async () => {
    const core = new DocumentCore({ doc: spikeDocument(), schedule: microtask });
    const views = eventViews(core);

    // Every view notifies its subscribers when the text changes; the listener reads the value the
    // element would turn into an event, and records it.
    const seen: string[] = [];
    const unsubs = Object.entries(views).map(([name, view]) =>
      view.subscribe(() => seen.push(`${name}:${JSON.stringify(view.get())}`)),
    );

    const i = internals(core);
    const at = posOf(i.state.doc, SPIKE_IDS.intro) + 2;
    i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, at)));
    i.dispatch(i.state.tr.insertText(SENTINEL));
    await flush();

    // The text is in the document, and the explicit method returns it once it is selected.
    const range = sentinelRange(internals(core).state.doc);
    expect(range).not.toBeNull();
    const r = range!;
    internals(core).dispatch(
      internals(core).state.tr.setSelection(
        TextSelection.create(internals(core).state.doc, r.from, r.to),
      ),
    );
    await flush();
    expect(JSON.stringify(core.getSelectionContent())).toContain(SENTINEL);

    // No view value carries it, neither the value read now nor any notified during the change.
    for (const [name, view] of Object.entries(views)) {
      expect(JSON.stringify(view.get()), `view ${name}`).not.toContain(SENTINEL);
    }
    expect(seen.length).toBeGreaterThan(0);
    for (const entry of seen) expect(entry).not.toContain(SENTINEL);

    for (const off of unsubs) off();
  });

  it('the explicit method is the only exit: a selection over the text returns it, the views do not', async () => {
    const core = new DocumentCore({ doc: spikeDocument(), schedule: microtask });
    const i = internals(core);
    const at = posOf(i.state.doc, SPIKE_IDS.intro) + 1;
    i.dispatch(i.state.tr.insertText(SENTINEL, at, at));
    await flush();
    const r = sentinelRange(internals(core).state.doc);
    expect(r).not.toBeNull();
    internals(core).dispatch(
      internals(core).state.tr.setSelection(
        TextSelection.create(internals(core).state.doc, r!.from, r!.to),
      ),
    );
    await flush();

    expect(JSON.stringify(core.getSelectionContent())).toContain(SENTINEL);
    expect(JSON.stringify(core.selection.get())).not.toContain(SENTINEL);
    expect(JSON.stringify(core.commands.get())).not.toContain(SENTINEL);
  });
});
