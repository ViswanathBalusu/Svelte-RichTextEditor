/**
 * Who the operator running a support tool is, and which tenants they are assigned to (BE-089
 * criteria 3 and 4; 06 §11). The spec names neither source; the choice is recorded in
 * docs/adr/0245-lane-BE-079-091.md (decision 7) for the owner to confirm.
 *
 * - The identity is the operating-system account that runs the tool, read by the tool itself
 *   (`os.userInfo()` in structural-dump-cli.ts). There is no flag to name it, so an operator cannot
 *   claim to be someone else on the command line. The audit trail records it as `operator:<account>`,
 *   which no tenant user's surrogate identifier has.
 * - The assignments are a JSON file the operator organisation keeps, named by
 *   `DOCEDIT_OPERATOR_ASSIGNMENTS`:
 *
 *       { "operators": { "<account>": ["<tenant uuid>", ...] } }
 *
 *   An account that is not listed, or a tenant that is not in its list, is not assigned. There are
 *   no wildcards. A file that does not have this shape is refused as a whole.
 */

/** The audit trail's actor for an operator account. */
export const OPERATOR_PREFIX = 'operator:';

export class AssignmentFileError extends Error {
  override name = 'AssignmentFileError';
}

export interface OperatorAssignments {
  /** Whether `actor` (as `operatorActor` gives it) is assigned to `tenant`. */
  isAssigned(tenant: string, actor: string): boolean;
}

/** The audit actor of an operating-system account, or null for an account with no usable name. */
export function operatorActor(account: string | null | undefined): string | null {
  const a = (account ?? '').trim();
  // Control characters and whitespace would make the actor ambiguous in the audit trail.
  if (!a || a.length > 128 || /[\s\p{Cc}]/u.test(a)) return null;
  return `${OPERATOR_PREFIX}${a}`;
}

/** Assignments that assign nobody to anything: what the tool uses when no file is configured. */
export const NO_ASSIGNMENTS: OperatorAssignments = { isAssigned: () => false };

/** The assignments of a file's text; throws `AssignmentFileError` when it does not have the shape. */
export function parseOperatorAssignments(text: string): OperatorAssignments {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AssignmentFileError('the assignment file is not JSON');
  }
  const operators =
    typeof json === 'object' && json !== null && !Array.isArray(json)
      ? (json as { operators?: unknown }).operators
      : undefined;
  if (typeof operators !== 'object' || operators === null || Array.isArray(operators))
    throw new AssignmentFileError('the assignment file has no "operators" object');
  const map = new Map<string, ReadonlySet<string>>();
  for (const [account, tenants] of Object.entries(operators)) {
    const actor = operatorActor(account);
    if (actor === null)
      throw new AssignmentFileError('an operator account in the file is not usable');
    if (!Array.isArray(tenants) || !tenants.every((t) => typeof t === 'string' && t.length > 0))
      throw new AssignmentFileError('an operator entry is not a list of tenant identifiers');
    map.set(actor, new Set(tenants as string[]));
  }
  return {
    isAssigned: (tenant, actor) => map.get(actor)?.has(tenant) ?? false,
  };
}
