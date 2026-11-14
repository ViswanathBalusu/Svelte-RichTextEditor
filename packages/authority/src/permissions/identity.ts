/**
 * The identity of suggestion marks (03 §5; 07 §16; PRM-014, PRM-060; ADR 0050 item 3). Whoever
 * submits a commit, every suggestion mark it brings into the document names the submitting user
 * and uses an identifier that belongs to them: "The authority checks that `user` equals the
 * submitting user" and "A suggestion `id` belongs to the user who first used it. The authority
 * rejects its use by anyone else." This rule forbids, so it is in the core of the outcome check and
 * applies to editors and server-authored commits as much as to suggesters; P4 (`suggestions.ts`)
 * only permits.
 *
 * - A mark whose identifier is known (from earlier commits, or from the content the room started
 *   with) must name the user that identifier belongs to. Copying or keeping someone's suggestion is
 *   therefore allowed; reusing the identifier of someone else's settled suggestion is not.
 * - A mark with a new identifier must name the submitter, which claims the identifier for them.
 * - Exception (spike S11 change 6; SR-M14): in a server-authored commit with origin `import`, a mark
 *   with a new identifier may name an import label; the label then owns the identifier. Outside
 *   imports a new mark never names a label, and a label never names a connected user.
 *
 * Only the subtrees the commit did not share with the document before it are visited: a shared
 * subtree is unchanged, so its marks were checked when they arrived.
 */
import type { Node } from 'prosemirror-model';
import { isImportLabel, isSuggestionMark } from './suggestions.ts';

export interface IdentityInput {
  before: Node;
  after: Node;
  /** The submitting user (`system` for commits no user requested). */
  user: string;
  /** Suggestion identifier → the user (or label) it belongs to. */
  owners: ReadonlyMap<string, string>;
  /** Whether new marks may name an import label: a server-authored commit with origin `import`. */
  importLabels: boolean;
}

export type IdentityVerdict =
  | { ok: true; claimed: ReadonlyMap<string, string>; visited: number }
  | { ok: false; scopes: string[]; reasons: string[] };

/** The scope of a child, given the scope of its parent and the parent's type (07 §5.1). */
function childScope(parent: Node, parentScope: string, child: Node): string {
  if (parent.type.name === 'doc') {
    if (child.type.name === 'story') return `story:${String(child.attrs['id'])}`;
    return child.type.name === 'body' ? 'body' : 'doc';
  }
  if (parent.type.name === 'body')
    return child.type.name === 'region' ? `region:${String(child.attrs['id'])}` : 'body';
  return parentScope;
}

export function suggestionIdentity(input: IdentityInput): IdentityVerdict {
  const { before, after, user, owners, importLabels } = input;
  const claimed = new Map<string, string>();
  const offending = new Set<string>();
  const reasons: string[] = [];
  let visited = 0;
  const deny = (scope: string, why: string) => {
    offending.add(scope);
    if (reasons.length < 5) reasons.push(`${scope}: ${why}`);
  };
  const check = (n: Node, scope: string) => {
    visited++;
    for (const m of n.marks) {
      if (!isSuggestionMark(m)) continue;
      const id = String(m.attrs['id']);
      const who: unknown = m.attrs['user'];
      const owner = owners.get(id) ?? claimed.get(id);
      if (owner !== undefined) {
        if (owner !== who)
          deny(scope, `suggestion identifier ${id} belongs to another user (03 §5)`);
        continue;
      }
      if (isImportLabel(who)) {
        if (importLabels) claimed.set(id, String(who));
        else deny(scope, 'only an import may attribute a suggestion to an import label (07 §15)');
      } else if (who !== user)
        deny(scope, 'a suggestion mark must name the submitting user (03 §5)');
      else claimed.set(id, user);
    }
  };
  const walk = (b: Node | null, a: Node, scope: string) => {
    check(a, scope);
    if (!a.childCount) return;
    const shared = new Set<Node>();
    b?.forEach((c) => shared.add(c));
    a.forEach((c, _offset, i) => {
      if (shared.has(c)) return;
      const counterpart = b && i < b.childCount ? b.child(i) : null;
      walk(
        counterpart && counterpart.type === c.type && !counterpart.isText ? counterpart : null,
        c,
        childScope(a, scope, c),
      );
    });
  };
  if (before !== after) walk(before, after, 'doc');
  if (offending.size) return { ok: false, scopes: [...offending].sort(), reasons };
  return { ok: true, claimed, visited };
}
