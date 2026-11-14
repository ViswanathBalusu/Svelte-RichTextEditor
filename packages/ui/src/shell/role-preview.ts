/**
 * The state of "preview as a role" (FRW-075): the author picks a role and sees what a participant
 * holding only that role would fill. This module is the model only. The editor does not yet draw
 * fill mode for a role (FRW-069 is not built), so nothing here is wired to the core.
 *
 * - Values typed in the preview live in an overlay that is never sent as a commit (criterion 2).
 *   Leaving the preview drops the overlay, so the document's values are the ones there were.
 * - Only fields whose `assignee` is the previewed role are fillable in the preview; other roles'
 *   fields are read-only there (criterion 1).
 * - The caret at the moment the preview starts is kept, and returned when it ends (criterion 3).
 */

export interface PreviewSession {
  readonly role: string;
  /** The caret when the preview started, or null when there was no caret. */
  readonly caret: number | null;
  /** Values entered in the preview, by field identifier. Never committed. */
  readonly overlay: ReadonlyMap<string, string>;
}

/** No preview is active. */
export type RolePreview = PreviewSession | null;

/**
 * Starts a preview as `role`. Starting again while a preview is active switches the role and keeps
 * the caret and the overlay of the first start: the author is still in the same preview.
 */
export function startPreview(
  current: RolePreview,
  role: string,
  caret: number | null,
): PreviewSession {
  if (current !== null) return { ...current, role };
  return { role, caret, overlay: new Map<string, string>() };
}

/** Whether a field may be filled in the preview of `role`: only the role's own fields. */
export function isFillableInPreview(assignee: string | null, role: string): boolean {
  return assignee !== null && assignee === role;
}

/**
 * Records a value typed in the preview. A field of another role, or no field, leaves the session
 * unchanged, so nothing outside the role's fields can be changed in the preview.
 */
export function setPreviewValue(
  session: PreviewSession,
  field: { readonly id: string; readonly assignee: string | null },
  value: string,
): PreviewSession {
  if (!isFillableInPreview(field.assignee, session.role)) return session;
  const overlay = new Map(session.overlay);
  overlay.set(field.id, value);
  return { ...session, overlay };
}

/** The value a field shows in the preview: the typed value if any, else the document's value. */
export function previewValue(
  session: PreviewSession,
  fieldId: string,
  documentValue: string,
): string {
  return session.overlay.get(fieldId) ?? documentValue;
}

/** Preview edits are never submitted as commits. */
export function mayCommitFromPreview(): false {
  return false;
}

/**
 * Leaves the preview. The overlay is dropped and the caret the author had is returned, so the
 * editor can put the caret back where it was (criterion 3).
 */
export function endPreview(session: PreviewSession): { readonly caret: number | null } {
  return { caret: session.caret };
}
