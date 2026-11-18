/** Transaction metadata the editing core's plugins share. */

/** A transaction that applies remote work (FE-033): never filtered, never sent, never in undo. */
export const REMOTE = 'docedit.remote';

/** A transaction the core appends itself (identifiers, the paragraph after a region). */
export const INTERNAL = 'docedit.internal';

/**
 * A transaction suggestion mode passes as it is (FE-041): one already recorded as suggestions, or
 * one that accepts or rejects suggestions (FE-047).
 */
export const SUGGESTED = 'docedit.suggested';

/** The origin of a commit that accepts or rejects suggestions (FE-047; 08 §14; UX-036). */
export const RESOLVE_ORIGIN = 'docedit.resolveOrigin';
/**
 * The origin hint of a commit that accepts or rejects suggestions, or that inserts an assistant's
 * approved result as suggestions (UX-046). The hint is a client claim (04 §2).
 */
export type ResolveOrigin = 'suggestion.accept' | 'suggestion.reject' | 'assistant';
