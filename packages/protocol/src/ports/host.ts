/**
 * The host's directory callbacks (05 §8.1 `searchPrincipals`, `resolveUsers`; 13 §5; 07 §7). The
 * document service keeps no profile data: names and avatars come from the host. Signatures are
 * decisions of S6 (G92).
 */

export interface UserInfo {
  /** The identifier the component received (`user.id`, `author.user`, presence; whether `sub` or the surrogate is G11). */
  id: string;
  name: string;
  avatarUrl?: string;
}

/** Resolves identifiers to people, in the order given; null for an identifier the host does not know. */
export type ResolveUsers = (ids: readonly string[]) => Promise<ReadonlyArray<UserInfo | null>>;

export interface PrincipalQuery {
  text: string;
  docId: string;
  /** Grants dialog (07 §7), mentions (13 §5), workflow participants (12 §6). */
  purpose: 'grant' | 'mention' | 'participant';
  kinds?: ReadonlyArray<'user' | 'group'>;
  limit?: number;
}

export interface PrincipalInfo {
  /** `user:<sub>` or `group:<id>` (07 §1). */
  principal: string;
  name: string;
  /** A second line, for example a department. */
  detail?: string;
}

/** Finds users and groups in the host's directory. */
export type SearchPrincipals = (query: PrincipalQuery) => Promise<PrincipalInfo[]>;
