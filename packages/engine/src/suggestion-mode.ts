/**
 * Suggestion mode by rule (FE-041; 02 §5.2; 07 §5.2 P4, §7; 03 §4.1). A pure function: given the
 * host's requested mode, the access, whether the document is read-only, the document's
 * `trackChanges` setting and the scope at the caret, it says whether typing is recorded as
 * suggestions, whether that can be switched off, and why.
 *
 * The rules, in the order they are decided:
 * - a locking mode (`view`, `fill`) or a read-only document changes nothing, so no suggestion mode;
 * - with no access (no backend), nothing limits the user and there is no suggestion mode;
 * - a scope where the user has `suggest` but not `edit` is always suggestion mode and cannot be
 *   switched off (reason `rights`);
 * - a scope where the user has `edit` and the document's `trackChanges` is `everyone` is suggestion
 *   mode for everyone; only a user with `manage` may switch it off (reason `document-setting`);
 * - a scope where the user has `edit` and the requested mode is `review` is suggestion mode, which
 *   the user may switch off by leaving review mode (reason `review-mode`);
 * - otherwise the user edits directly.
 *
 * What is not here: the caret, the switcher and the core's read-only view that reports the state
 * (FE-041 criteria 1, 3, 4 and 5) are the core's and the shell's. The function is the rule they use.
 *
 * Universal logic: no Node.js or browser API.
 */
import type { Access } from '@docedit/protocol';
import type { EditMode } from './api.ts';
import { capsOf, depScope } from './guard.ts';
import { modeLocks } from './mode.ts';

/** Why suggestion mode is on, or why it is off when the rules would otherwise say on. */
export type SuggestionReason = 'rights' | 'document-setting' | 'review-mode';

export interface SuggestionModeInput {
  /** The mode the host asked for. */
  readonly requested: EditMode;
  /** The access in force; null means no backend limits the user. */
  readonly access: Access | null;
  /** Whether the document is read-only for this user. */
  readonly readOnly: boolean;
  /** The document's `settings.trackChanges`, as the authority reads it. */
  readonly trackChanges: 'off' | 'everyone' | undefined;
  /** The scope at the caret, an authority scope name (`body`, `region:<id>`, `story:<id>`, …). */
  readonly scope: string;
}

export interface SuggestionModeState {
  /** Whether a typed change is recorded as a suggestion in this scope. */
  readonly on: boolean;
  /** Whether the user cannot switch suggestion mode off here. */
  readonly locked: boolean;
  /** Why it is on, or null when it is off. */
  readonly reason: SuggestionReason | null;
}

const OFF: SuggestionModeState = { on: false, locked: false, reason: null };

/** The suggestion mode in force at the caret under the rules above (FE-041). */
export function suggestionMode(input: SuggestionModeInput): SuggestionModeState {
  if (modeLocks(input.requested) || input.readOnly) return OFF;
  const access = input.access;
  if (access === null) return OFF;
  const caps = capsOf(access, depScope(input.scope));
  const canEdit = caps.includes('edit');
  const canSuggest = caps.includes('suggest');
  if (!canEdit) return canSuggest ? { on: true, locked: true, reason: 'rights' } : OFF;
  if (input.trackChanges === 'everyone') {
    const manages = access.caps.includes('manage');
    return { on: true, locked: !manages, reason: 'document-setting' };
  }
  if (input.requested === 'review') return { on: true, locked: false, reason: 'review-mode' };
  return OFF;
}
