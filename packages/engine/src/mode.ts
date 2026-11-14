/**
 * The editing mode (02 §5.2; FE-029). The host sets the mode it asks for; the core enforces the most
 * restrictive mode the user's access allows, and keeps the host's value as it was.
 *
 * - `edit`: changes are allowed where the access allows them.
 * - `review`: suggestion mode (FE-041, not built yet). Changes are allowed where the access allows
 *   `edit` or `suggest`; the server's permissions still apply.
 * - `view`: no change at all. Selection and copying are unaffected.
 * - `fill`: the body is read-only (FE-029 criterion 6). Field values follow in FRW-076 and FRW-079;
 *   until then nothing changes in this mode.
 *
 * Universal code: no Node.js or browser API.
 */
import type { Access } from '@docedit/protocol';
import type { EditMode } from './api.ts';

export type { EditMode, ModeState } from './api.ts';

export const EDIT_MODES: readonly EditMode[] = ['edit', 'review', 'view', 'fill'];

/** Whether a mode refuses every change to the document. */
export function modeLocks(mode: EditMode): boolean {
  return mode === 'view' || mode === 'fill';
}

/**
 * The mode in force for `requested` under `access`: the requested mode when the access allows it,
 * otherwise the most restrictive mode the access does allow. Without an access (no backend), nothing
 * limits the requested mode.
 */
export function effectiveMode(requested: EditMode, access: Access | null): EditMode {
  if (requested === 'view') return 'view';
  if (!access) return requested;
  // A user may change something when some scope grants the capability, not only the document
  // (a region editor has no document-level `edit`, 07 §4): the scope rules decide the rest.
  const granted = new Set<string>(access.caps);
  for (const caps of Object.values(access.scopes)) for (const c of caps) granted.add(c);
  const has = (c: string): boolean => granted.has(c);
  switch (requested) {
    case 'edit':
      if (has('edit')) return 'edit';
      return has('suggest') ? 'review' : 'view';
    case 'review':
      return has('edit') || has('suggest') ? 'review' : 'view';
    case 'fill':
      return has('fill') ? 'fill' : 'view';
  }
}
