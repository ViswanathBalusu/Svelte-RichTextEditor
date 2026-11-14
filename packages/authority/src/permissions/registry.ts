/**
 * The seams of the outcome check (07 §5; PRM-010). The core of the check (`outcome.ts`) justifies a
 * changed scope only by `edit` (P1). Two rules justify scopes without `edit`, and they are modules
 * registered here rather than built into the core:
 *
 * - `suggest` (P4, 07 §5.2; PRM-014): a scope where the user has `suggest` but not `edit`;
 * - `fill` (P7, 12 §4.2; FRW-008): a field value the user may not change under P1.
 *
 * A module only ever adds a justification for a scope the core routes to it. When the module is
 * not registered, throws, or answers anything but a positive verdict, the scope stays unjustified
 * and the commit is refused: the check fails closed. Every rule that forbids something (P2, P3,
 * P5, P6, P8, P9, the `manage` operations and 07 §5.3) is in the core and cannot be unregistered.
 */
import type { Node } from 'prosemirror-model';
import type { Access } from './access.ts';
import type { PermissionState } from './model.ts';
import type { FieldChange } from './scopes.ts';

/** A scope's content as a list of nodes; a region inside the body appears by reference. */
export type ScopeContent = ReadonlyArray<Node | { regionRef: string }>;

export interface SuggestionContext {
  user: string;
  /** Suggestion identifier → the user who first used it. */
  owners: ReadonlyMap<string, string>;
  /**
   * A server-authored commit with origin `import`: marks that name an import label and use a new
   * identifier count as the committer's own (spike S11 change 6; SR-M14; ADR 0050 item 3).
   */
  importLabels?: boolean;
}

export type SuggestionVerdict = { ok: true; claimed: string[] } | { ok: false; reason: string };

/** P4: decides a scope where the user may suggest but not edit. */
export interface SuggestRule {
  /** The rule's name in rejections, for example `P4`. */
  readonly id: string;
  check(
    scope: string,
    before: ScopeContent,
    after: ScopeContent,
    ctx: SuggestionContext,
  ): SuggestionVerdict;
}

export interface FillContext {
  user: string;
  access: Access;
  perms: PermissionState;
  /** The document after the commit. */
  after: Node;
  /**
   * Visibility and enablement of fields under the rules (12 §5); FRW supplies it. `key` is the
   * field's key after the commit, so that the gate need not look the field up (PRM-016).
   */
  fieldEnabled?: (fieldId: string, after: Node, key?: string) => boolean;
}

export type RuleVerdict = { ok: true } | { ok: false; reason: string };

/** P7: decides a field value that the user may not change under P1. */
export interface FillRule {
  readonly id: string;
  check(field: FieldChange, ctx: FillContext): RuleVerdict;
}

export interface OutcomeRules {
  readonly suggest?: SuggestRule;
  readonly fill?: FillRule;
}

/** No module registered: suggestions and fills are refused (fail closed). */
export const NO_RULES: OutcomeRules = Object.freeze({});
