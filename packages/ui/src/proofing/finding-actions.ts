/**
 * The actions an author can take on a proofing finding (UX-042; 13 §6.1; P4 in 07 §12).
 *
 * `offeredFindingActions` says which actions a finding's context menu or keyboard command offers,
 * for the author's capabilities at the finding's scope:
 *
 * - A finding is shown only to an author who can view its scope (the port receives text only from
 *   scopes the user can view, 13 §6.1), so without `view` nothing is offered.
 * - "apply" needs a suggestion to apply, a capability to change text there (`edit`, or `suggest`
 *   for a user who may only suggest) and a mode that writes text (`edit` or `review`). Its mode is
 *   `edit` for a user with `edit` in `edit` mode, and `suggest` otherwise: in `review` mode (the
 *   shell's suggestion mode, `shell/suggest-mode.ts`), or for a user who holds only `suggest`, the
 *   change becomes a suggestion (P4). In a scope the user may not change, or in `view` or `fill`
 *   mode, "apply" is not offered.
 * - "ignore once" and "ignore everywhere" change no text, so they are offered to every viewer.
 * - "add to dictionary" is offered only when the proofing port supports custom dictionaries
 *   (criterion 3). A port without them shows no dictionary control.
 *
 * This module changes nothing and stores nothing. The edit itself goes through the core's guards
 * (criterion 2, the caller's), and the storage of dictionaries is the port's (criterion 3).
 * Not built: the context menu, the keyboard command, the language recomputation of criterion 4.
 */
import type { Capability, EditorMode } from '../core-api.ts';

export type FindingAction = 'apply' | 'ignore-once' | 'ignore-everywhere' | 'add-to-dictionary';

export type ApplyMode = 'edit' | 'suggest';

export interface FindingActionContext {
  /** The author's capabilities at the scope of the finding (the core supplies them). */
  readonly caps: readonly Capability[];
  /** The editor mode in effect at the finding (`review` is suggestion mode). */
  readonly mode: EditorMode;
  /** Whether the finding carries at least one suggestion to apply. */
  readonly hasSuggestion: boolean;
  /** Whether the proofing port supports custom dictionaries. */
  readonly dictionaries: boolean;
}

export type OfferedAction =
  | { readonly action: 'apply'; readonly mode: ApplyMode }
  | { readonly action: 'ignore-once' | 'ignore-everywhere' | 'add-to-dictionary' };

/** The mode a change takes for this author, or null when the author may not change text here. */
export function applyMode(context: FindingActionContext): ApplyMode | null {
  const canEdit = context.caps.includes('edit');
  const canSuggest = context.caps.includes('suggest');
  if (!canEdit && !canSuggest) return null;
  if (context.mode !== 'edit' && context.mode !== 'review') return null;
  return context.mode === 'edit' && canEdit ? 'edit' : 'suggest';
}

/** The actions offered for a finding, in the order a menu shows them. */
export function offeredFindingActions(context: FindingActionContext): OfferedAction[] {
  if (!context.caps.includes('view')) return [];
  const actions: OfferedAction[] = [];
  const mode = applyMode(context);
  if (context.hasSuggestion && mode !== null) actions.push({ action: 'apply', mode });
  actions.push({ action: 'ignore-once' }, { action: 'ignore-everywhere' });
  if (context.dictionaries) actions.push({ action: 'add-to-dictionary' });
  return actions;
}
