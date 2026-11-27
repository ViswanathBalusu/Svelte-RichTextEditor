/**
 * Acting on an accessibility issue (UX-067; 13 section 8). For each issue the shell needs the fix
 * it offers and whether this user may make it. The fix names are the shell's own identifiers for
 * the command or field that repairs the element; the checker pane runs each one through the core's
 * `fixBlock` (`BlockFix` in core-api.ts), which applies the scope guard again.
 *
 * The permission comes from the caller, so this module needs no document model and no core. The
 * caller in the product is `accessibility-run.ts`, which builds `FixAccess` from the core's DEP
 * access (`permissions`, 05 §5.5) and the derived region list (`regions`, PRM-032).
 */
import type { CheckIssue, CheckKind } from './accessibility-check.ts';

/** The field or command that repairs an issue of each kind (UX-067 criterion 2). */
export type FixTarget =
  'picture.altText' | 'table.headerRow' | 'link.text' | 'style.headingLevel' | 'format.colour';

export const FIX_FOR: Readonly<Record<CheckKind, FixTarget>> = {
  'alt-text': 'picture.altText',
  'table-header': 'table.headerRow',
  'link-text': 'link.text',
  'heading-order': 'style.headingLevel',
  contrast: 'format.colour',
};

/** What the caller knows about the element's scope for this user. */
export interface FixAccess {
  /** True when this user may change the block (the access rules of UX-004 and 07 section 4). */
  mayEdit(blockId: string): boolean;
  /**
   * Who can make the change when this user cannot (UX-067 criterion 3), in the words the shell
   * shows: for a region, the same sentence as its lock indicator (PRM-026). Empty when unknown.
   */
  whoCanFix(blockId: string): string;
}

export type Fixability =
  | { readonly fixable: true; readonly fix: FixTarget; readonly blockId: string }
  | {
      readonly fixable: false;
      readonly fix: FixTarget;
      readonly blockId: string;
      /** Who can fix it, in words; empty when the access view says nothing about it. */
      readonly who: string;
    };

/** Whether the author can fix an issue here, and which field or command would do it. */
export function fixability(issue: CheckIssue, access: FixAccess): Fixability {
  const fix = FIX_FOR[issue.kind];
  if (access.mayEdit(issue.blockId)) {
    return { fixable: true, fix, blockId: issue.blockId };
  }
  return {
    fixable: false,
    fix,
    blockId: issue.blockId,
    who: access.whoCanFix(issue.blockId),
  };
}
