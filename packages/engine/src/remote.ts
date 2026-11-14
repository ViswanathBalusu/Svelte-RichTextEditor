/**
 * Remote work in the editing state (FE-033 criterion 3; FE-035): one transaction, marked as remote,
 * that turns the visible document into the sync client's rebuilt one (sync/state.ts).
 *
 * The transaction has the shape prosemirror-collab gives a rebuild: the old unconfirmed steps
 * undone, the confirmed change applied, the new unconfirmed steps applied, each paired ("mirrored")
 * with the step it was rebased from. Positions inside local edits then map exactly through the
 * rebuild (the caret during a composition, decorations), and prosemirror-history rebases its
 * entries through the pairing (the `rebased` metadata) and drops those of discarded steps.
 *
 * The document never depends on that construction: the sync client computed the result from the
 * confirmed document (04 §7; review CONV-1), the transaction's result is compared with it, and any
 * difference (an inverse of a mark step is not exact once another mark overlapped it) is corrected
 * with one replace step, so the visible document is always exactly the rebuilt one (ADR 0038).
 */
import { inverseMapsOf, rebaseOver } from '@docedit/authority';
import type { Node } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';
import type { Step } from 'prosemirror-transform';
import { REMOTE } from './meta.ts';
import type { Rebuild } from './sync/state.ts';

interface MirrorMapping {
  setMirror(n: number, m: number): void;
}

/**
 * How many rebuilds needed the correcting step or the fallback, and how often the editor's document
 * was not the confirmed document plus the unconfirmed steps (diagnostics for the tests).
 */
export const rebuildStats = {
  built: 0,
  corrected: 0,
  fallback: 0,
  mismatch: 0,
  /** Rebuilds with unconfirmed steps whose undo history was mapped, not rebased (core.ts). */
  historyMapped: 0,
  /** Where the last fallback or correction came from, for diagnosis. */
  last: '',
};

/**
 * Applies a step to a transaction; false when it fails. Applying a step can throw inside
 * prosemirror-transform (an attribute step that lands on a text node), as spike S3 found for the
 * authority: that is a failure, never an exception that escapes.
 */
function tryStep(tr: Transaction, step: Step): boolean {
  try {
    return !tr.maybeStep(step).failed;
  } catch {
    return false;
  }
}

/**
 * Whether prosemirror-history can rebase its entries through the rebuild's pairing. Its `rebased`
 * handling pairs the last history items with the mirrored steps in order and keeps the maps of
 * the steps before the first mirrored one only. So every step after the first mirrored one must be
 * mirrored too, with the old steps in increasing order; otherwise a remote step's map is lost, an
 * older entry keeps stale positions, and its undo can apply an identifier step to a text node.
 */
export function historyRebasable(e: Rebuild): boolean {
  const origins = [...e.overOrigins, ...e.afterOrigins];
  const first = origins.findIndex((o) => o >= 0);
  if (first < 0) return true;
  for (let k = first; k < origins.length; k++) {
    if (origins[k]! < 0) return false;
    if (k > first && origins[k]! <= origins[k - 1]!) return false;
  }
  return true;
}

/**
 * The transaction that applies a rebuild to a state whose document is `base` plus `before`.
 * `rebaseHistory` says whether the last undo history items are the old unconfirmed steps, one per
 * step (core.ts); only then is the history rebased through the pairing, and otherwise it is mapped.
 */
export function rebuildTransaction(
  state: EditorState,
  e: Rebuild,
  rebaseHistory = true,
): Transaction {
  rebuildStats.built++;
  const tr = state.tr.setMeta(REMOTE, true).setMeta('addToHistory', false);
  const mirror = tr.mapping as unknown as MirrorMapping;
  const n = e.before.length;
  let ok = true;
  if (n > 0) {
    const docs: Node[] = [];
    let d = e.base;
    try {
      for (const step of e.before) {
        docs.push(d);
        const r = step.apply(d);
        if (!r.doc) {
          ok = false;
          break;
        }
        d = r.doc;
      }
      if (ok && !d.eq(state.doc)) {
        rebuildStats.mismatch++;
        ok = false;
      }
      for (let i = n - 1; ok && i >= 0; i--)
        if (!tryStep(tr, e.before[i]!.invert(docs[i]!))) ok = false;
    } catch {
      ok = false;
    }
  } else if (!e.base.eq(state.doc)) {
    rebuildStats.mismatch++;
    ok = false;
  }
  const pairs = (steps: readonly Step[], origins: readonly number[], phase: string) => {
    steps.forEach((step, k) => {
      if (!ok) return;
      if (!tryStep(tr, step)) {
        ok = false;
        rebuildStats.last = `${phase} ${k}/${steps.length} ${JSON.stringify(step.toJSON()).slice(0, 160)} before=${e.before.length} base-equal=${String(undone?.eq(e.base))}`;
        return;
      }
      const origin = origins[k] ?? -1;
      if (origin >= 0 && origin < n) mirror.setMirror(n - 1 - origin, tr.steps.length - 1);
    });
  };
  const undone = ok ? tr.doc : null;
  if (ok) pairs(e.over, e.overOrigins, 'over');
  if (ok) pairs(e.after, e.afterOrigins, 'after');
  if (ok && n > 0 && rebaseHistory && historyRebasable(e)) tr.setMeta('rebased', n);
  else if (ok && n > 0) rebuildStats.historyMapped++;
  if (!ok) {
    rebuildStats.fallback++;
    return replaceAll(state, e.doc);
  }
  if (!tr.doc.eq(e.doc)) {
    rebuildStats.corrected++;
    // The correcting step is paired with nothing: the history is mapped through it instead.
    tr.setMeta('rebased', undefined);
    let fresh: Node | null = e.base;
    for (const s of [...e.over, ...e.after]) fresh = fresh ? (s.apply(fresh).doc ?? null) : null;
    rebuildStats.last = `corrected: before=${e.before.length} over=${e.over.length} after=${e.after.length} base-equal=${String(undone?.eq(e.base))} fresh-equal=${String(fresh?.eq(e.doc))} tr-equal-fresh=${String(fresh?.eq(tr.doc))} over=${JSON.stringify(e.over.map((s) => s.toJSON())).slice(0, 400)}`;
    correct(tr, e.doc);
  }
  return tr;
}

/** Appends the one replace step that turns `tr.doc` into `target`. */
function correct(tr: Transaction, target: Node): void {
  const start = tr.doc.content.findDiffStart(target.content);
  if (start === null) return;
  const end = tr.doc.content.findDiffEnd(target.content)!;
  let endA = end.a;
  let endB = end.b;
  const overlap = start - Math.min(endA, endB);
  if (overlap > 0) {
    endA += overlap;
    endB += overlap;
  }
  tr.replace(start, endA, target.slice(start, endB));
  if (!tr.doc.eq(target)) tr.replace(0, tr.doc.content.size, target.slice(0, target.content.size));
}

/** A remote transaction that replaces the whole content (used when a rebuild cannot be built). */
function replaceAll(state: EditorState, target: Node): Transaction {
  const tr = state.tr.setMeta(REMOTE, true).setMeta('addToHistory', false);
  correct(tr, target);
  return tr;
}

/**
 * Steps made on the visible document, expressed on the confirmed document: mapped back through the
 * unconfirmed steps. Used by the spike's stand-in for remote commits made on the visible document.
 */
export function onConfirmed(
  steps: readonly Step[],
  unconfirmed: readonly Step[],
  confirmed: Node,
): Step[] {
  const r = rebaseOver(steps, inverseMapsOf(unconfirmed), confirmed, 'drop');
  return r.ok ? r.value.steps : [];
}
