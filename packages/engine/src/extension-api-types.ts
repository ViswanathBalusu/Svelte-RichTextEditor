/**
 * The range-based document API offered to extensions (UX-053; 13 §7.1; ADR 0234 part B, proposed).
 * Only plain data appears here: numbers, strings, JSON and functions. No ProseMirror type is named,
 * so an extension never depends on the editing core's library (02 §5.1; `api.test.ts` scans this
 * file as it scans `api.ts`).
 *
 * Positions are offsets into the document. They mean something only to this API and only for the
 * document as it is now: a range an extension holds is a handle, and the core maps it through every
 * local and remote change (ADR 0234 B2).
 */
import type { CdmFragment } from './cdm-fragment.ts';

/** A handle to a span of the document. The core keeps it mapped; `from` and `to` are the span when it was made. */
export interface ExtRange {
  readonly id: string;
  readonly from: number;
  readonly to: number;
}

/**
 * Where a held range is now. `stale` is true when something changed inside it since it was made,
 * so a write through it is refused; `detached` when everything it covered was deleted.
 */
export interface ExtRangeState {
  readonly from: number;
  readonly to: number;
  readonly stale: boolean;
  readonly detached: boolean;
}

/**
 * Why a write did not happen (ADR 0234 B1). `permission_denied`: the scope may not be changed by
 * this user (or the document is locked); `conflict`: the range no longer covers the content it was
 * made on; `invalid`: the range, the text, the mark or the fragment is not acceptable; `unsupported`:
 * the fragment needs a feature the document does not list; `refused`: the guards or suggestion mode
 * refused the change.
 */
export type ExtWriteFailure =
  'permission_denied' | 'conflict' | 'invalid' | 'unsupported' | 'refused';

export type ExtWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ExtWriteFailure; readonly message: string };

/** A block with an identifier, as a reader of its scope may see it. */
export interface ExtBlock {
  readonly id: string;
  readonly type: string;
  readonly from: number;
  readonly to: number;
  /** The plain text of the block, from scopes the reader may view. */
  readonly text: string;
}

export interface ExtMarkRun {
  readonly from: number;
  readonly to: number;
  readonly marks: readonly {
    readonly type: string;
    readonly attrs: Readonly<Record<string, unknown>>;
  }[];
}

export interface ExtSuggestion {
  readonly id: string;
  readonly kind: 'ins' | 'del' | 'fmt';
  readonly author: string | null;
}

export interface ExtComment {
  readonly id: string;
  readonly detached: boolean;
}

/** Where the change came from: this user's edits, other people's, or both since the last delivery. */
export type ExtOrigin = 'local' | 'remote' | 'both';

interface Base {
  /** The confirmed `seq` of the document when the change was made (04 §7). */
  readonly seq: number;
  readonly origin: ExtOrigin;
}

export interface ExtEventMap {
  /** Blocks (anything with an identifier) that are new, differ, or are gone. Identifiers only. */
  'blocks.added': Base & { readonly ids: readonly string[] };
  'blocks.changed': Base & { readonly ids: readonly string[] };
  'blocks.deleted': Base & { readonly ids: readonly string[] };
  'selection.changed': Base & { readonly anchor: number; readonly head: number };
  'suggestions.changed': Base & { readonly ids: readonly string[] };
  'comments.changed': Base & { readonly ids: readonly string[] };
}

export type ExtEventName = keyof ExtEventMap;

export interface ExtensionApiOptions {
  /**
   * The most ranges one API holds at once. Required: the spec gives no number (ADR 0136, proposed).
   * A range is held from `range()` until `release()` or `dispose()`.
   */
  readonly maxRanges: number;
  /** Runs a delivery. Delivery is always asynchronous (UX-054); the default is the frame scheduler. */
  readonly later?: (run: () => void) => void;
  /** Receives an error a handler threw. The error never reaches the editor. */
  readonly onError?: (error: unknown, event: ExtEventName) => void;
}

export interface ExtensionDocumentApi {
  /** Holds a range. Throws a RangeError for positions outside the document or when `maxRanges` are held. */
  range(from: number, to: number): ExtRange;
  /** The selection as a held range. */
  selection(): ExtRange;
  /** Where the range is now; null for a range that was released or never made here. */
  current(range: ExtRange): ExtRangeState | null;
  release(range: ExtRange): void;

  /** Reads return what is in the mapped range now, from scopes the reader may view (ADR 0019). */
  blocks(range: ExtRange): readonly ExtBlock[];
  text(range: ExtRange): string;
  marks(range: ExtRange): readonly ExtMarkRun[];
  comments(range: ExtRange): readonly ExtComment[];
  suggestions(range: ExtRange): readonly ExtSuggestion[];

  /**
   * Writes go through the guards of typing: refused in a scope without edit rights, recorded as a
   * suggestion in suggestion mode. A range that changed since it was made gives `conflict`.
   */
  insertBlocks(at: ExtRange, content: CdmFragment): ExtWriteResult;
  replaceRange(range: ExtRange, text: string): ExtWriteResult;
  deleteRange(range: ExtRange): ExtWriteResult;
  setMark(range: ExtRange, type: string, attrs?: Readonly<Record<string, unknown>>): ExtWriteResult;

  /**
   * Subscribes to an event. Delivery is asynchronous and never inside the transaction. Changes made
   * before one delivery are reported together, as a change from the document at the last delivery
   * to the document now. Returns the function that unsubscribes.
   */
  on<E extends ExtEventName>(event: E, handler: (event: ExtEventMap[E]) => void): () => void;
  /** Releases every range and every subscription. */
  dispose(): void;
}
