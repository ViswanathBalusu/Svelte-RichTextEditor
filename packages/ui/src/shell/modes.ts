/**
 * Which modes the switcher offers and which it allows (UX-015; 07 §4, §7; 05 §8.1 `mode`).
 *
 * - Only modes the build supports are listed (`CoreApi.modes`); without that view, `edit` and
 *   `view`, which every core has.
 * - `view` is always available.
 * - `edit` needs `edit` somewhere in the document; it is unavailable while the document is locked,
 *   archived or out for completion, and where the user may only suggest at the selection, because
 *   there the editor stays in suggestion mode and cannot leave it (07 §7).
 * - `review` needs `suggest` or `edit` somewhere (the build lists it once suggestion mode exists).
 * - `fill` needs `fill` somewhere.
 *
 * "Somewhere" is the union of the document-level capabilities and those of every scope of the DEP
 * access, so a viewer with an edit grant on one region may still choose `edit`.
 */
import type { AccessObject, AccessSummary, EditorMode } from '../core-api.ts';

export const ALL_MODES: readonly EditorMode[] = ['edit', 'review', 'view', 'fill'];

export interface ModeOption {
  readonly mode: EditorMode;
  readonly available: boolean;
  /** A reason code (`reason.query.<code>`) when unavailable. */
  readonly reason: string | null;
}

/** Capabilities in any scope of the document. */
export function capabilitiesAnywhere(access: AccessObject | null | undefined): Set<string> {
  const out = new Set<string>(access?.caps ?? []);
  for (const caps of Object.values(access?.scopes ?? {})) for (const c of caps) out.add(c);
  return out;
}

const DOCUMENT_LIMITS = new Set(['locked', 'archived', 'workflow']);

export function modeOptions(
  supported: readonly EditorMode[] | undefined,
  access: AccessObject | null | undefined,
  here: AccessSummary | undefined,
): ModeOption[] {
  const listed = (supported ?? ['edit', 'view']).filter((m) => ALL_MODES.includes(m));
  // Without any access object yet, nothing is known to be missing: the server decides.
  const anywhere = access ? capabilitiesAnywhere(access) : null;
  const has = (cap: string) => anywhere === null || anywhere.has(cap);
  const limit = here?.limit ?? null;
  const suggestOnly =
    here !== undefined && here.caps.includes('suggest') && !here.caps.includes('edit');
  return ALL_MODES.filter((m) => listed.includes(m)).map((mode): ModeOption => {
    switch (mode) {
      case 'view':
        return { mode, available: true, reason: null };
      case 'edit':
        if (limit !== null && DOCUMENT_LIMITS.has(limit))
          return { mode, available: false, reason: limit };
        if (!has('edit')) return { mode, available: false, reason: 'noEdit' };
        if (suggestOnly) return { mode, available: false, reason: 'suggestOnly' };
        return { mode, available: true, reason: null };
      case 'review':
        if (limit !== null && DOCUMENT_LIMITS.has(limit))
          return { mode, available: false, reason: limit };
        return has('suggest') || has('edit')
          ? { mode, available: true, reason: null }
          : { mode, available: false, reason: 'noSuggest' };
      case 'fill':
        return has('fill')
          ? { mode, available: true, reason: null }
          : { mode, available: false, reason: 'noFill' };
    }
  });
}
