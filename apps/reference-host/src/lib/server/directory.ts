/**
 * The host's directory: the people and groups of the demo (seed/users.json; UX-092, UX-093). The
 * document service keeps no profile data (05 §8.1): the page asks the host for names through
 * `resolveUsers` and for people to grant roles to through `searchPrincipals`, and the host answers
 * from here. A real host reads its own user store.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface DirectoryUser {
  /** Opaque and stable; never an e-mail address (05 §3.1). */
  sub: string;
  name: string;
  groups: string[];
  /** One line for the demo sign-in page. */
  about: string;
}

export interface DirectoryGroup {
  id: string;
  name: string;
}

/** What `resolveUsers` returns for one identifier (05 §8.1; `UserInfo` of @docedit/protocol). */
export interface UserInfo {
  id: string;
  name: string;
}

/** What `searchPrincipals` returns (`PrincipalInfo` of @docedit/protocol). */
export interface PrincipalInfo {
  principal: string;
  name: string;
  detail?: string;
}

/** 05 §3.1: 1 to 255 characters, no whitespace; this host also refuses anything like an e-mail. */
export function isOpaqueSub(sub: unknown): sub is string {
  return typeof sub === 'string' && /^[^\s@]{1,255}$/.test(sub) && !/[\p{Cc}]/u.test(sub);
}

export class Directory {
  readonly #users: ReadonlyMap<string, DirectoryUser>;
  readonly #groups: ReadonlyMap<string, DirectoryGroup>;

  constructor(users: readonly DirectoryUser[], groups: readonly DirectoryGroup[]) {
    for (const u of users)
      if (!isOpaqueSub(u.sub)) throw new Error(`seed user ${u.sub}: sub must be opaque`);
    this.#users = new Map(users.map((u) => [u.sub, u]));
    this.#groups = new Map(groups.map((g) => [g.id, g]));
  }

  static async load(seedDir: string): Promise<Directory> {
    const raw = JSON.parse(await readFile(join(seedDir, 'users.json'), 'utf8')) as {
      users: DirectoryUser[];
      groups: DirectoryGroup[];
    };
    return new Directory(raw.users, raw.groups);
  }

  get users(): readonly DirectoryUser[] {
    return [...this.#users.values()];
  }

  /** The seeded groups, in seed order (the share dialog lists them, UX-095). */
  get groups(): readonly DirectoryGroup[] {
    return [...this.#groups.values()];
  }

  user(sub: string): DirectoryUser | null {
    return this.#users.get(sub) ?? null;
  }

  /** `resolveUsers`: in the order given, null for an identifier the host does not know. */
  resolve(ids: readonly string[]): Array<UserInfo | null> {
    return ids.map((id) => {
      const u = this.#users.get(id);
      return u ? { id: u.sub, name: u.name } : null;
    });
  }

  /** `searchPrincipals`: users and groups whose name or identifier contains `text`. */
  search(text: string, kinds: ReadonlyArray<'user' | 'group'>, limit: number): PrincipalInfo[] {
    const q = text.trim().toLocaleLowerCase('en-GB');
    const hit = (...values: string[]) =>
      q === '' || values.some((v) => v.toLocaleLowerCase('en-GB').includes(q));
    const out: PrincipalInfo[] = [];
    if (kinds.includes('user'))
      for (const u of this.#users.values())
        if (hit(u.name, u.sub)) out.push({ principal: `user:${u.sub}`, name: u.name });
    if (kinds.includes('group'))
      for (const g of this.#groups.values())
        if (hit(g.name, g.id))
          out.push({ principal: `group:${g.id}`, name: g.name, detail: 'Group' });
    return out.slice(0, Math.max(0, limit));
  }
}
