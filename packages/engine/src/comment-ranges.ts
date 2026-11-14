/**
 * Comment ranges on the client (02 §5.2; FE-048; ADR 0015; 07 §6). A thread's range is kept outside
 * the document, as the authority keeps it, and is mapped through every step with the authority's own
 * function (`mapRanges`, SYN-001), so a highlight stays on the text it was drawn on. A range whose
 * text is deleted collapses, and its thread is reported as detached; a collapsed range stays
 * collapsed when text is typed at its position.
 *
 * This module holds no decoration and draws nothing: the decorations, the keyboard access and the
 * "no commit on create, resolve or reopen" rule belong to the view and the threads UI (FE-048).
 */
import { type MappedRange, mapRanges } from '@docedit/authority';
import type { StepMap } from 'prosemirror-transform';

export interface ThreadRange {
  readonly from: number;
  readonly to: number;
  /** True when everything the range covered was deleted; the thread is then detached. */
  readonly detached: boolean;
  /** The `seq` the range is valid at (the commit it was last mapped to). */
  readonly seq: number;
}

interface Entry {
  from: number;
  to: number;
  detached: boolean;
  seq: number;
}

export class CommentRanges {
  readonly #ranges = new Map<string, Entry>();

  /**
   * Replaces the client's copy of a thread's range, as a `thread.updated` event does (FE-048). The
   * range is valid at `seq`; later maps are applied with `apply`.
   */
  set(threadId: string, range: { from: number; to: number }, seq: number): void {
    const to = Math.max(range.from, range.to);
    this.#ranges.set(threadId, {
      from: range.from,
      to,
      detached: to <= range.from,
      seq,
    });
  }

  /** Removes a thread's range (the thread was deleted). */
  remove(threadId: string): void {
    this.#ranges.delete(threadId);
  }

  /**
   * Maps every range through the step maps of one transaction or commit, and advances their `seq`.
   * A range that was already detached stays detached.
   */
  apply(maps: readonly StepMap[], seq: number): void {
    if (maps.length === 0) return;
    for (const [id, entry] of this.#ranges) {
      const [mapped] = mapRanges([{ from: entry.from, to: entry.to }], maps);
      const m: MappedRange = mapped!;
      this.#ranges.set(id, {
        from: m.from,
        to: m.to,
        detached: entry.detached || m.collapsed,
        seq,
      });
    }
  }

  /** The current range of a thread, or undefined when the thread has none. */
  get(threadId: string): ThreadRange | undefined {
    const e = this.#ranges.get(threadId);
    return e ? { from: e.from, to: e.to, detached: e.detached, seq: e.seq } : undefined;
  }

  /** The thread ids the client holds a range for, in insertion order. */
  ids(): string[] {
    return [...this.#ranges.keys()];
  }
}
