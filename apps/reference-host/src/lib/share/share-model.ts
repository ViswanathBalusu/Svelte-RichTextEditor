/**
 * The share dialog's rules (UX-095; 13 section 5, 11.2; 05 sections 3.1 and 3.3). Pure functions,
 * so that the dialog's rows, the role choices and the message the owner reads after a save are the
 * same ones the tests check. The host decides roles (they go into the token's `docs` claim); this
 * module decides nothing the service does not also enforce.
 */
import type { DocRole } from '@docedit/protocol';

/** The document-level roles the share dialog offers, in the order of 13 section 5. */
export const SHARE_ROLES: readonly DocRole[] = [
  'viewer',
  'commenter',
  'suggester',
  'editor',
  'owner',
  'filler',
];

/** A role to set, or `none` to take the person's role away. */
export type RoleChoice = DocRole | 'none';

/** The value of a role choice from the form, or undefined for anything that is not one. */
export function parseRoleChoice(value: string): RoleChoice | undefined {
  if (value === 'none') return 'none';
  return SHARE_ROLES.find((r) => r === value);
}

const LABELS: Readonly<Record<RoleChoice, string>> = {
  none: 'No access',
  viewer: 'Viewer',
  commenter: 'Commenter',
  suggester: 'Suggester',
  editor: 'Editor',
  owner: 'Owner',
  filler: 'Filler',
};

/** The name of a role as the dialog shows it. */
export function roleLabel(role: DocRole | null): string {
  return LABELS[role ?? 'none'];
}

/**
 * When a role change takes effect. Changing an existing role ends the person's sessions on the
 * document at once (`changeRole` in documents.ts revokes on any change of an existing role); a
 * role given to someone without one takes effect with their next token (05 section 3.3).
 */
export type Effect = 'now' | 'next-token';

export function roleEffect(before: DocRole | null, after: DocRole | null): Effect {
  return before !== null && before !== after ? 'now' : 'next-token';
}

/** The sentence the dialog shows after a save, saying when the change takes effect (UX-095 criterion 2). */
export function effectSentence(effect: Effect): string {
  return effect === 'now'
    ? 'Their sessions on this document have ended, so the change applies now.'
    : 'The change applies from their next token, at most 15 minutes later.';
}

/** The message after a role is saved: who, the role now, and when it takes effect. */
export function roleSavedMessage(name: string, after: DocRole | null, effect: Effect): string {
  return `${name} is now ${after ?? 'without access'}. ${effectSentence(effect)}`;
}

/** A group and its members with their own document roles (groups hold no role of their own here). */
export interface GroupRow {
  id: string;
  name: string;
  members: Array<{ sub: string; name: string; role: DocRole | null }>;
}

/**
 * The groups the dialog lists, with each member's role. A group does not hold a document role in
 * this demo: the token and the catalogue keep roles per person, so a group row is read-only.
 */
export function groupRows(
  groups: ReadonlyArray<{ id: string; name: string }>,
  users: ReadonlyArray<{ sub: string; name: string; groups: readonly string[] }>,
  roleOf: (sub: string) => DocRole | null,
): GroupRow[] {
  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    members: users
      .filter((u) => u.groups.includes(g.id))
      .map((u) => ({ sub: u.sub, name: u.name, role: roleOf(u.sub) })),
  }));
}
