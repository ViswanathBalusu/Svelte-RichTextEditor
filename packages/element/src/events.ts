/**
 * The events of the embedding API (05 §8.1; FE-022; PRO-087).
 *
 * Every event leaves the component through `emit`: a `CustomEvent` with `bubbles: true` and
 * `composed: true`, so a listener on the element or on the document receives it, with the element
 * as the target at the host level. A `detail` carries identifiers, registry codes and counts only,
 * never document text or a token (05 §8.1; 10 §3.1; ADR 0019). The access object of
 * `de-permission-change` holds capabilities keyed by scope identifiers, and user identifiers in
 * `leases`; it holds no content.
 *
 * The package's ESLint configuration refuses any other `dispatchEvent` and any `CustomEvent` in
 * the element's source (eslint.config.js), and test/events.test.ts checks that it does.
 */
import type { Access, ErrorCode } from '@docedit/protocol';

export type Connection = 'online' | 'reconnecting' | 'offline';
export type SyncState = 'saved' | 'saving' | 'unsaved' | 'readonly';

export interface StatusDetail {
  connection: Connection;
  sync: SyncState;
}

export interface ErrorDetail {
  /** A code of the error registry (05 §5.8). */
  code: ErrorCode;
  /** A description for logs. Never document content or a token. */
  message: string;
  /** True when the editor cannot continue without the host acting, for example by calling `load()`. */
  fatal: boolean;
}

/**
 * The events this release raises. The catalogue of 05 §8.1 has more (`de-fork-request`); each arrives with its
 * story and is added here, so that it goes through `emit` too.
 */
export interface DocEditorEventMap {
  /** The document is loaded and the editor is live (PRO-074). */
  'de-ready': { docId: string; seq: number };
  /** Connection or save state changed; at most once per animation frame (FE-007). */
  'de-status': StatusDetail;
  /** Changes were confirmed up to `seq`; at most once per interval (PRO-087). */
  'de-change': { seq: number };
  /** The access of the open channel, first from `ch.opened`, then from every `perm.changed` (PRO-088). */
  'de-permission-change': Access;
  /** `getToken` failed or the server refused the token (PRO-075). Carries no token. */
  'de-auth-required': { docId: string; code: ErrorCode };
  /** Rejected or unsent content was set aside; `count` is the number of pieces (05 §8.1). */
  'de-recovered-edits': { count: number };
  /**
   * The owner asked for sharing, which the host owns (PRO-089; 13 §5). Identifiers only: the host
   * opens its own dialog, and the editor shows none of its own. Nothing listens and nothing breaks
   * when the host has no listener.
   */
  'de-share-request': { docId: string };
  /**
   * A reader asked for access to hidden content (UX-104, ADR 0019). `scope` is the DEP scope
   * identifier of the placeholder. The host decides who answers; the editor sends nothing itself.
   */
  'de-access-request': { docId: string; scope: string };
  /** An export job reports its state (PRO-086): identifiers and job state only, no content. */
  'de-export-progress': { jobId: string; state: string; progress: number | null };
  /** The export job completed (PRO-086). Same detail as `de-export-progress`. */
  'de-export-completed': { jobId: string; state: string; progress: number | null };
  /** The export job failed or was cancelled (PRO-086). Same detail as `de-export-progress`. */
  'de-export-failed': { jobId: string; state: string; progress: number | null };
  /** The selection moved to another scope or block (05 §8.1; FE-028). Identifiers only, no content. */
  'de-selection': SelectionDetail;
  /** The commands whose `enabled` or `active` state changed, and only those (FE-028). */
  'de-command-state': { commands: CommandStateChange[] };
  /**
   * The mode in effect, or the mode asked for, changed; also raised once when the editor is live
   * (UX-014 criterion 5; proposed, ADR 0361).
   */
  'de-mode-change': ModeChangeDetail;
  /** The other sessions this reader may see changed; also raised once when the editor is live (UX-014; ADR 0361). */
  'de-presence': PresenceDetail;
  /** The counts of the header's buttons changed; also raised once when the editor is live (UX-014; ADR 0361). */
  'de-counts': CountsDetail;
  /** This person changed the entry of a form field (12 §10; FRW-070). It carries no value. */
  'de-field-change': FieldChangeDetail;
  /** The progress the guided bar of fill mode shows changed (12 §10; FRW-070). */
  'de-fill-progress': FillProgressDetail;
  'de-error': ErrorDetail;
}

/** `de-field-change`: the field and the state of its entry, and never the value (12 §10). */
export interface FieldChangeDetail {
  fieldId: string;
  key: string;
  /** False when the entry has a problem, or the field is required and the entry is empty. */
  valid: boolean;
  empty: boolean;
}

/**
 * `de-fill-progress`: what the guided bar shows as "n of m". `total` is the required fields this
 * participant must fill, `filled` those of them that are filled and valid. 12 §10 names the event
 * and not its detail; these members are proposed (FRW-070 Notes).
 */
export interface FillProgressDetail {
  filled: number;
  total: number;
}

/** `de-mode-change`: `mode` is the mode in effect, `requested` the one the host or the user asked for. */
export interface ModeChangeDetail {
  mode: string;
  requested: string;
}

/**
 * `de-presence`: one entry per other session, with identifiers and a status only. The host resolves
 * `user` in its own directory; no name and no selection is carried.
 */
export interface PresenceDetail {
  peers: { session: string; user: string; status: 'active' | 'idle' }[];
}

/** `de-counts`: open comment threads and catch-up activity; `null` while a count is unknown. */
export interface CountsDetail {
  comments: number | null;
  catchUp: number | null;
}

/** `de-selection`: a DEP scope identifier and the block the selection starts in (05 §8.1). */
export interface SelectionDetail {
  scope: string;
  blockId: string | null;
}

/** One command of `de-command-state` with its new state. */
export interface CommandStateChange {
  name: string;
  enabled: boolean;
  active: boolean;
}

export type DocEditorEventName = keyof DocEditorEventMap;

export const EVENT_NAMES: readonly DocEditorEventName[] = [
  'de-ready',
  'de-status',
  'de-change',
  'de-permission-change',
  'de-auth-required',
  'de-recovered-edits',
  'de-share-request',
  'de-access-request',
  'de-export-progress',
  'de-export-completed',
  'de-export-failed',
  'de-selection',
  'de-command-state',
  'de-mode-change',
  'de-presence',
  'de-counts',
  'de-field-change',
  'de-fill-progress',
  'de-error',
];

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/**
 * Dispatches an event of the embedding API from `target` (the element). The detail is copied and
 * frozen, so a listener can neither change the component's state through it nor see later
 * changes. Returns what `dispatchEvent` returns.
 */
export function emit<K extends DocEditorEventName>(
  target: EventTarget,
  name: K,
  detail: DocEditorEventMap[K],
): boolean {
  const copy = deepFreeze(structuredClone(detail));
  return target.dispatchEvent(
    new CustomEvent(name, { bubbles: true, composed: true, cancelable: false, detail: copy }),
  );
}
