/**
 * Reasons for commands the user's access does not allow (UX-004; 07 §4, §7). The server remains the
 * authority (PRODUCT principle 2); this is the "see before you try" half.
 */
import type { AccessSummary, Capability } from '../core-api.ts';
import type { StringKey } from '../i18n/en-GB.ts';
import { CONTENT_CAPABILITIES } from './types.ts';

/** Whether the access allows changing content (edit, or suggest in suggestion mode). */
export function canChangeContent(access: AccessSummary | undefined): boolean {
  if (!access) return true;
  return access.caps.some((c: Capability) => CONTENT_CAPABILITIES.includes(c));
}

/** The string key that explains why content cannot be changed under this access. */
export function reasonKeyFor(access: AccessSummary): StringKey {
  switch (access.limit) {
    case 'approved':
      return 'reason.access.approved';
    case 'lease':
      return 'reason.access.lease';
    case 'locked':
      return 'reason.access.locked';
    case 'archived':
      return 'reason.access.archived';
    case 'workflow':
      return 'reason.access.workflow';
    case 'unlisted':
      return 'reason.access.unlisted';
    case 'hidden':
      return 'reason.access.hidden';
    case 'region':
      return 'reason.access.region';
    default:
      return access.caps.includes('comment') ? 'reason.access.comment' : 'reason.access.view';
  }
}

/**
 * What to announce when the access changes while the selection stays in the same scope: that is a
 * permission change (`perm.changed`), not a move of the caret. Null when nothing is announced.
 */
export function accessChangeAnnouncement(
  previous: AccessSummary | undefined,
  next: AccessSummary | undefined,
): StringKey | null {
  if (!previous || !next || previous.scope !== next.scope) return null;
  const before = canChangeContent(previous);
  const after = canChangeContent(next);
  if (before && !after) return 'announce.access.lost';
  if (!before && after) return 'announce.access.gained';
  return null;
}
