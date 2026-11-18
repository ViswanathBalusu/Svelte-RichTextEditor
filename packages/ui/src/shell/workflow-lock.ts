/**
 * What the shell says while a workflow holds the document (FRW-029 criterion 6; 12 §3.3, §6.2). Plain
 * functions, without the DOM. The lock itself is the service's (`lockFor` in the authority): a document
 * is locked while the workflow is `sent` or `in_progress` (people may only fill), and stays locked once
 * it was `declined` or `voided`. The other states are not decided by 12 (ADR 0249), so no banner is
 * shown for them. Names are the owner's text and are shown as text.
 */
import type { WorkflowParticipantView } from '../core-api.ts';

export type LockKind = 'running' | 'declined' | 'voided';

/** The lock the state implies, or null when the state does not lock the document. */
export function lockKind(state: string | null): LockKind | null {
  switch (state) {
    case 'sent':
    case 'in_progress':
      return 'running';
    case 'declined':
      return 'declined';
    case 'voided':
      return 'voided';
    default:
      return null;
  }
}

/** How a participant is named: the owner's name, else the roles held, else the identifier. */
export function participantLabel(p: WorkflowParticipantView): string {
  if (p.name !== null && p.name.trim() !== '') return p.name;
  return p.roles.length > 0 ? p.roles.join(', ') : p.id;
}

export interface LockBanner {
  readonly kind: LockKind;
  /** Who may act now: the participants in state `active`, in the order the resource lists them. */
  readonly actors: readonly string[];
}

/** The banner for a workflow state and its participants; null when the state does not lock. */
export function lockBanner(
  state: string | null,
  participants: readonly WorkflowParticipantView[],
): LockBanner | null {
  const kind = lockKind(state);
  if (kind === null) return null;
  // A stopped workflow has nobody left to act: the document is read-only for everyone.
  const actors =
    kind === 'running'
      ? participants.filter((p) => p.state === 'active').map(participantLabel)
      : [];
  return { kind, actors };
}
