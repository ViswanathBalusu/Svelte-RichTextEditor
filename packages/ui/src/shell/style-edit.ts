/**
 * Why a style cannot be created, changed or deleted, in the shell's terms (UX-022 criteria 2 and
 * 3). The core says whether the user's rights and the document allow it (`CoreApi.styleEdit`) and
 * which regions use the style (07 §5.3). The core cannot see whether such a region is approved,
 * which is the server's state; the shell reads it from the region list and says so before the
 * server would refuse it (PRM-047), naming the region that blocks it.
 */
import type { RegionSummary, StyleEditCheck, StyleEditOp, StyleEditReason } from '../core-api.ts';

export interface StyleBlock {
  /** The core's reason, or `approved` for a region that uses the style and is approved. */
  readonly reason: StyleEditReason | 'approved';
  /** The identifiers of the regions that block it (empty when no region is named). */
  readonly regions: readonly string[];
}

/** Reasons that hold for every style: the user, not the style, is the limit. */
export const USER_REASONS: ReadonlySet<StyleBlock['reason']> = new Set([
  'read-only',
  'suggestion',
  'no-access',
]);

/**
 * What stops the edit, or null when nothing the shell can see does. Changing or deleting a style
 * that a region uses is stopped while that region is approved, whoever the user is.
 */
export function styleBlock(
  check: StyleEditCheck | undefined,
  op: StyleEditOp,
  regions: readonly RegionSummary[],
): StyleBlock | null {
  if (check === undefined) return null;
  if (!check.ok) return { reason: check.reason, regions: check.regions };
  if (op === 'create') return null;
  const approved = check.regions.filter(
    (id) => regions.find((r) => r.id === id)?.state === 'approved',
  );
  return approved.length > 0 ? { reason: 'approved', regions: approved } : null;
}

/**
 * Whether a name is unusable for a style of `kind`: empty, or already the name of another style of
 * the kind (compared without regard to case, as the core does).
 */
export function nameProblem(
  styles: readonly { id: string; kind: string; name: string }[],
  kind: string,
  name: string,
  except: string | null,
): 'bad-name' | 'duplicate-name' | null {
  const wanted = name.trim().toLowerCase();
  if (wanted === '') return 'bad-name';
  const taken = styles.some(
    (s) => s.id !== except && s.kind === kind && s.name.trim().toLowerCase() === wanted,
  );
  return taken ? 'duplicate-name' : null;
}

/** The styles a style of `kind` may be based on: those of its kind, never itself. */
export function parentChoices<T extends { id: string; kind: string }>(
  styles: readonly T[],
  kind: string,
  except: string | null,
): T[] {
  return styles.filter((s) => s.kind === kind && s.id !== except);
}
