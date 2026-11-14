/**
 * The lifecycle of one assistant request in the assistant pane (UX-045; 13 §6.2, §12).
 *
 * A pure reducer. The pane sends it events (start, a response, a failure, a cancel, the author's
 * approval) and draws the state it returns. Nothing here calls a port, edits the document or
 * changes the DOM.
 *
 * - A response is held in the state and is not inserted. Only `approve`, sent by the author after a
 *   response is shown, produces an insertion (`insert`), and only when the author may change text
 *   there. The insertion itself is UX-046's (it arrives as suggestions); this reducer only says
 *   which text it would insert.
 * - A failure (`rate_limited`, `quota_exceeded` or a port failure) ends the request with nothing
 *   held and retry offered (criterion 4). A cancel while running ends it with the response discarded
 *   (criterion 3). The port's own stop of the request is the caller's.
 * - `assistantPaneOffered` says the pane is not offered without an assistant port (criterion 5).
 * - `insertionAllowed` gives the view-only author a disabled insertion with the reason (criterion 6).
 *   `assistantAsk` applies the same gate to the requests: questions and summaries need only `view`
 *   (they change nothing); drafts and rewrites would insert text, so they also need `edit` or
 *   `suggest`. Each refused request carries a reason.
 * - `retryOffered` and `errorMessageKey` say what a failed request shows (criterion 4), and
 *   `announcement` names the message a live region would read for progress and completion
 *   (input to criterion 7). The message keys are names only: the string catalogue has no entries
 *   for them yet.
 *
 * Not built: the pane, the port, the live region (criterion 7), and the cancel of a running request
 * at the port (criterion 3's stop). No criterion of UX-045 is ticked on this module alone.
 */
import type { Capability } from '../core-api.ts';

export type AssistantKind = 'draft' | 'rewrite' | 'summary' | 'question';

export type AssistantFailure = 'rate_limited' | 'quota_exceeded' | 'port_failure';

export type AssistantState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'running'; readonly kind: AssistantKind }
  | { readonly phase: 'shown'; readonly kind: AssistantKind; readonly text: string }
  | {
      readonly phase: 'failed';
      readonly kind: AssistantKind;
      readonly failure: AssistantFailure;
      readonly retry: true;
    }
  | { readonly phase: 'cancelled'; readonly kind: AssistantKind };

export type AssistantEvent =
  | { readonly type: 'start'; readonly kind: AssistantKind }
  | { readonly type: 'response'; readonly text: string }
  | { readonly type: 'failure'; readonly failure: AssistantFailure }
  | { readonly type: 'cancel' }
  | { readonly type: 'approve' }
  | { readonly type: 'dismiss' };

/** The result of a step: the new state, and the text an approval would insert (else null). */
export interface AssistantStep {
  readonly state: AssistantState;
  readonly insert: string | null;
}

export const IDLE: AssistantState = { phase: 'idle' };

/** Whether the assistant pane is offered at all: only with an assistant port (UX-045 criterion 5). */
export function assistantPaneOffered(port: unknown): boolean {
  return port !== undefined && port !== null;
}

/**
 * Whether an approved response may be inserted at the selection: the author needs `edit` or
 * `suggest` there (the insertion arrives as suggestions for a suggester, UX-046). A view-only author
 * gets false, and the caller shows the reason (criterion 6).
 */
export function insertionAllowed(caps: readonly Capability[]): boolean {
  return caps.includes('edit') || caps.includes('suggest');
}

/** One step of the lifecycle. Only `approve` from a shown response yields text to insert. */
export function assistantStep(
  state: AssistantState,
  event: AssistantEvent,
  allowInsert: boolean,
): AssistantStep {
  const hold = (next: AssistantState): AssistantStep => ({ state: next, insert: null });
  switch (event.type) {
    case 'start':
      return state.phase === 'running' ? hold(state) : hold({ phase: 'running', kind: event.kind });
    case 'response':
      if (state.phase !== 'running') return hold(state);
      return hold({ phase: 'shown', kind: state.kind, text: event.text });
    case 'failure':
      if (state.phase !== 'running') return hold(state);
      return hold({ phase: 'failed', kind: state.kind, failure: event.failure, retry: true });
    case 'cancel':
      if (state.phase !== 'running') return hold(state);
      return hold({ phase: 'cancelled', kind: state.kind });
    case 'approve':
      if (state.phase !== 'shown' || !allowInsert) return hold(state);
      return { state: IDLE, insert: state.text };
    case 'dismiss':
      return hold(IDLE);
  }
}

/** Retry is offered only after a failed request (criterion 4). */
export function retryOffered(state: AssistantState): boolean {
  return state.phase === 'failed';
}

/** The message key the author sees for a failed request (criterion 4). */
export function errorMessageKey(failure: AssistantFailure): string {
  return `assistant.error.${failure}`;
}

/** The message key a live region would announce for the state, or null for none (criterion 7). */
export function announcement(state: AssistantState): string | null {
  switch (state.phase) {
    case 'running':
      return 'assistant.progress';
    case 'shown':
      return 'assistant.done';
    case 'failed':
      return errorMessageKey(state.failure);
    default:
      return null;
  }
}

/** Why a request is refused: no `view` at the selection, or no right to change text there. */
export type AssistantAskRefusal = 'no-view' | 'no-change';

export type AssistantAskOffer =
  { readonly enabled: true } | { readonly enabled: false; readonly reason: AssistantAskRefusal };

/**
 * Whether the author may make this request at the selection (criterion 6). Every request needs
 * `view`. Questions and summaries need nothing more. Drafts and rewrites would insert text, so they
 * need what `insertionAllowed` needs.
 */
export function assistantAsk(kind: AssistantKind, caps: readonly Capability[]): AssistantAskOffer {
  if (!caps.includes('view')) return { enabled: false, reason: 'no-view' };
  if (kind === 'question' || kind === 'summary') return { enabled: true };
  if (!insertionAllowed(caps)) return { enabled: false, reason: 'no-change' };
  return { enabled: true };
}
