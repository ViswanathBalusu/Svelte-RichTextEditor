/**
 * Runs the accessibility checker over the document the core holds and lists each issue with what
 * this user can do about it (UX-066, UX-067). This is the caller of `checkDocument` and
 * `fixability` in the product: it reads the core's document (`getContent`), its DEP access
 * (`permissions`, 05 §5.5) and its derived region list (`regions`, PRM-032), and changes nothing.
 *
 * Fixability follows the access of the scope the block is in, as the region lock indicators do
 * (PRM-026): the user may fix an issue when that scope's capabilities include `edit`. Who can fix
 * it is the region's lock-indicator sentence, or, in the body, the document roles that edit it
 * (07 §2). A region the reader may not see is not in the document they hold (ADR 0019), so no
 * issue names it.
 */
import type { AccessObject, CoreApi, RegionSummary } from '../core-api.ts';
import type { Translator } from '../i18n/strings.ts';
import { checkDocument, type CheckIssue, type CheckReport } from './accessibility-check.ts';
import { checkViewOfContent } from './accessibility-content.ts';
import { fixability, type FixAccess, type Fixability } from './accessibility-fix.ts';
import { listOf, whoCanEdit, type NameOf } from './regions.ts';

export interface ListedIssue {
  readonly issue: CheckIssue;
  /** The DEP scope of the block: `body` or `region:<id>`. */
  readonly scope: string;
  readonly fix: Fixability;
}

export interface AccessibilityResult {
  readonly report: CheckReport;
  /** Every issue of the report, in the report's order (grouped by kind). */
  readonly issues: readonly ListedIssue[];
}

/** What the run reads of the core; every member is an optional one of `CoreApi`. */
export type CheckedCore = Pick<CoreApi, 'getContent' | 'permissions' | 'regions'>;

/** The capabilities of a scope; the body falls back to the document-level ones. */
function capsOf(access: AccessObject | null | undefined, scope: string): readonly string[] {
  if (!access) return [];
  return access.scopes[scope] ?? (scope === 'body' ? access.caps : []);
}

/** `FixAccess` over the DEP access and the region list, for blocks whose scopes are known. */
export function scopeFixAccess(
  scopes: ReadonlyMap<string, string>,
  access: AccessObject | null | undefined,
  regions: readonly RegionSummary[],
  tr: Translator,
  nameOf: NameOf,
): FixAccess {
  const scopeOf = (blockId: string): string => scopes.get(blockId) ?? 'body';
  return {
    mayEdit: (blockId) => capsOf(access, scopeOf(blockId)).includes('edit'),
    whoCanFix: (blockId) => {
      const scope = scopeOf(blockId);
      const m = /^region:(.+)$/.exec(scope);
      if (m) {
        const region = regions.find((r) => r.id === m[1]);
        return region ? whoCanEdit(region, tr, nameOf) : '';
      }
      const roles = listOf(tr.locale, [tr.t('region.role.editor'), tr.t('region.role.owner')]);
      return tr.t('region.editors.roles', { roles });
    },
  };
}

/**
 * Checks the document the core holds. Null when the core does not give its document
 * (`getContent` absent), so the shell offers no checker it cannot back.
 */
export function runAccessibilityCheck(
  core: CheckedCore,
  tr: Translator,
  nameOf: NameOf,
): AccessibilityResult | null {
  if (!core.getContent) return null;
  const view = checkViewOfContent(core.getContent());
  const report = checkDocument(view.blocks, view.options);
  const access = scopeFixAccess(
    view.scopes,
    core.permissions?.get() ?? null,
    core.regions?.get() ?? [],
    tr,
    nameOf,
  );
  const issues = report.groups.flatMap((group) =>
    group.issues.map((issue) => ({
      issue,
      scope: view.scopes.get(issue.blockId) ?? 'body',
      fix: fixability(issue, access),
    })),
  );
  return { report, issues };
}
