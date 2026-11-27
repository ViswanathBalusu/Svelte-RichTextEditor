/**
 * The `requires` of a document after some commits (03 §11.1; CDM-047; UX-107). A commit that added
 * a feature carries the grown list (`LogCommit.requires`); a commit that added none carries none.
 * So the list at a sequence number is the last list a commit up to it carried, or the list of the
 * checkpoint the replay started from.
 */
import type { LogCommit } from '@docedit/authority';

export function requiresAfter(
  start: readonly string[],
  commits: readonly Pick<LogCommit, 'requires'>[],
): string[] {
  for (let i = commits.length - 1; i >= 0; i--) {
    const r = commits[i]?.requires;
    if (r) return [...r];
  }
  return [...start];
}
