/**
 * Role markers of form fields for a participant (FRW-074 criterion 4, FRW-077; 12 §3.1, §11). Plain
 * functions, without the DOM: the fill pane draws them (`FillPane.svelte`) and the fill counts
 * (`fill.ts`) use the same ownership rule, so the bar never leads to a field the pane marks
 * read-only.
 *
 * What is not here: the insert palette (FRW-072) is the `insert.field.<kind>` commands of
 * `commands/builtin.ts` with the query source `fieldInsertSource`; the field node views and their
 * native controls are the core's (FRW-079); the roles manager is FRW-074.
 */
import type { FillField, FillSummary } from '../core-api.ts';
import type { Translator } from '../i18n/strings.ts';

/** Icon names for roles. The component draws them; the order is the role's place in the list. */
export const ROLE_ICONS = [
  'circle',
  'square',
  'triangle',
  'diamond',
  'pentagon',
  'hexagon',
  'star',
  'cross',
] as const;

export type RoleIcon = (typeof ROLE_ICONS)[number];

/**
 * The icon of a role, derived from its order in the document's role list (FRW-074). The first
 * `ROLE_ICONS.length` roles get distinct icons; past that the icons repeat. The spec stores no icon
 * on a `role_def`, so this is the shell's default until the owner decides (ADR 0113, round 2).
 */
export function roleIcon(order: number): RoleIcon {
  const n = ROLE_ICONS.length;
  return ROLE_ICONS[((Math.floor(order) % n) + n) % n]!;
}

/** Whose field it is for this participant (FRW-077). */
export type Ownership = 'mine' | 'other' | 'none';

/**
 * Whose field it is. `assignee` undefined means the core did not say, which a core that lists only
 * the participant's own fields does (FRW-076): such a field is theirs. Null is a field only authors
 * set, which is nobody's to fill. Otherwise the field is theirs exactly when they hold the role.
 */
export function ownership(
  assignee: string | null | undefined,
  myRoles: readonly string[],
): Ownership {
  if (assignee === undefined) return 'mine';
  if (assignee === null || assignee === '') return 'none';
  return myRoles.includes(assignee) ? 'mine' : 'other';
}

/** The fields this participant fills, in document order (the bar and the summary count these). */
export function ownFields(summary: FillSummary): FillField[] {
  const roles = summary.roles ?? [];
  return summary.fields.filter((f) => ownership(f.assignee, roles) === 'mine');
}

export interface FieldMarker {
  readonly ownership: Ownership;
  /** True when the participant cannot change the field now (not theirs, or not their turn). */
  readonly readOnly: boolean;
  /** The role's name; null when the field has no role or the reader may not see it. */
  readonly roleName: string | null;
  /**
   * The marker's visible text: "Yours" for the participant's field, the role's name for another
   * role's ("A role you do not hold" when the name is not known), "No role" for an unassigned one.
   */
  readonly text: string;
  readonly color: string | null;
  readonly icon: RoleIcon | null;
  /** The accessible name: the label and the role, in the current locale (FRW-077 criterion 1). */
  readonly name: string;
}

/**
 * The marker of one field for a participant. A field of a role the participant does not hold is
 * read-only and names that role; a field of their own role is marked as theirs and is editable only
 * while the participant is active; a field with no assignee is read-only for them.
 */
export function fieldMarker(
  field: Pick<FillField, 'label' | 'assignee' | 'role'>,
  myRoles: readonly string[],
  active: boolean,
  tr: Translator,
): FieldMarker {
  const own = ownership(field.assignee, myRoles);
  // A field only authors set has no role to show, whatever the core sent with it.
  const role = own === 'none' ? null : (field.role ?? null);
  const roleName = role?.name ?? null;
  let name: string;
  let text: string;
  if (own === 'mine') {
    text = tr.t('field.mine');
    name =
      roleName === null
        ? tr.t('field.name.mineUnnamed', { label: field.label })
        : tr.t('field.name.mine', { label: field.label, role: roleName });
  } else if (own === 'other') {
    text = roleName ?? tr.t('field.role.hidden');
    name = tr.t('field.name.other', { label: field.label, role: text });
  } else {
    text = tr.t('field.role.none');
    name = tr.t('field.name.none', { label: field.label });
  }
  return {
    ownership: own,
    readOnly: own !== 'mine' || !active,
    roleName,
    text,
    color: role?.color ?? null,
    icon: role ? roleIcon(role.order) : null,
    name,
  };
}
