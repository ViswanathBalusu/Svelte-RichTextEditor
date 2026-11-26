/**
 * Spelling and grammar findings from the proofing port (UX-041, UX-042; 13 §6.1; 02 §15).
 *
 * The controller keeps what the port said about each block, and shows it only while the block's
 * text is the text the port was given:
 *
 * - A block's text and language go to the port when the document opens (`start`) and, after a pause
 *   in typing, when a block's text or language changed. Only changed blocks are sent again.
 * - Text goes only from scopes the reader may view. A block in another scope is counted, never sent.
 * - A result is stored with the text it was computed for. A finding is shown only where the block
 *   still holds exactly that text, so a late result is never drawn on text that moved under it. This
 *   is the "discard" option of UX-041 criterion 3; mapping would need the position map of the
 *   transactions, and a changed block is checked again anyway.
 * - The port is never awaited on the typing path. A port that is slow leaves the state at
 *   `checking`; one that fails or throws leaves it at `unavailable`, quietly, and the next change of
 *   text tries again. Nothing here sets the core's `problem`.
 * - A finding never changes the document. The decorations are drawn from `locate()` on each draw.
 *
 * The port's findings are untrusted input: a finding for a block that was not sent, with an empty
 * or out-of-range span, is dropped, and every string is used as text only.
 *
 * Open, and so a default of this module (UX-041 Notes): the pause before a check
 * (`DEFAULT_DEBOUNCE_MS`), proofing per block, no proofing of headers, footers, footnotes or
 * definitions (only the body is proofed), and the text under a suggestion's deletion mark is sent
 * as it is. "Ignore everywhere" lasts for the session of this controller; where it is kept is open.
 */
import type {
  DictionaryEntry,
  DictionaryScope,
  ProofingPort as ProtocolProofingPort,
} from '@docedit/protocol';
import type { Node as PMNode } from 'prosemirror-model';

/** The pause after the last change of text before the changed blocks are sent. Provisional. */
export const DEFAULT_DEBOUNCE_MS = 400;

/** The language tag sent for a block that has neither a `lang` mark nor a document default. */
export const UNDETERMINED = 'und';

/**
 * The proofing port, with the custom dictionary members of 13 §6.1 ("supports custom dictionaries"):
 * `listWords` and `removeWord` beside `addWord` (the protocol's port, UX-042; owner decision 34: one
 * list for each person and one shared list for the tenant). A port without both has no dictionary
 * controls.
 */
export type ProofingPort = ProtocolProofingPort;
export type { DictionaryEntry, DictionaryScope };

export interface ProofingClock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** What the controller needs of the core. */
export interface ProofingHost {
  doc(): PMNode;
  /** Whether the reader may view the scope (`body`, `region:<id>`); the port gets text only from these. */
  canView(scope: string): boolean;
  docId(): string;
  /** The document's default language (`settings.lang`), a BCP 47 tag; null when not set. */
  defaultLang(): string | null;
  /** Called when the state or the findings changed, so the core publishes and redraws. */
  changed(): void;
}

export type ProofingState = 'idle' | 'checking' | 'unavailable';

/** A block of the body as the proofing sees it. */
export interface BlockSnapshot {
  readonly id: string;
  readonly scope: string;
  readonly text: string;
  readonly lang: string;
  /** The document position of the first character of the block's text. */
  readonly start: number;
}

/** A finding placed in the current document. */
export interface LocatedFinding {
  /** Stable while the block's text is unchanged: block, offsets and kind. */
  readonly id: string;
  readonly blockId: string;
  readonly scope: string;
  readonly kind: string;
  readonly message: string;
  readonly suggestions: readonly string[];
  /** The text the finding covers. */
  readonly text: string;
  readonly lang: string;
  /** Document positions. */
  readonly from: number;
  readonly to: number;
}

/** The finding as the interface reads it (no document position). */
export interface ProofingFindingInfo {
  readonly id: string;
  readonly kind: string;
  readonly message: string;
  readonly text: string;
  readonly suggestions: readonly string[];
  readonly scope: string;
  readonly lang: string;
}

/** What the interface reads (the core's `proofing` view). */
export interface ProofingInfo {
  /** A proofing port is attached. No proofing control appears without one (UX-041 criterion 5). */
  readonly available: boolean;
  readonly state: ProofingState;
  /** The findings shown now. */
  readonly count: number;
  /** Blocks left out of the last request because the reader may not view their scope. */
  readonly omitted: number;
  /** The port stores custom dictionaries: it can add, list and remove entries (UX-042 criterion 3). */
  readonly dictionary: boolean;
  /** The finding the last navigation chose, if it is still shown. */
  readonly current: ProofingFindingInfo | null;
  /** Moves on every change of the findings, so a view draws them again even when the counts match. */
  readonly version: number;
  /** The finding the caret is in, if any. */
  readonly atCaret: ProofingFindingInfo | null;
}

export const NO_PROOFING: ProofingInfo = {
  available: false,
  state: 'idle',
  count: 0,
  omitted: 0,
  dictionary: false,
  current: null,
  atCaret: null,
  version: 0,
};

/** Whether the port can store custom dictionaries: add, list and remove. */
export function supportsDictionary(port: ProofingPort): boolean {
  return (
    typeof port.addWord === 'function' &&
    typeof port.listWords === 'function' &&
    typeof port.removeWord === 'function'
  );
}
