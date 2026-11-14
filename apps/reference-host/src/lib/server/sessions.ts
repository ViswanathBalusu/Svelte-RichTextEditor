/**
 * Demo sign-in (UX-092 criterion 1): a visitor picks a seeded person and no password is asked.
 * This stands in for the host's real sign-in; the token endpoint then trusts this session as a
 * real host trusts its own.
 *
 * Each person's session cookie is scoped to the paths under `/as/<sub>/`, so one browser can act as
 * two people in two tabs, which the demo of 11 §3 needs. The cookie is HttpOnly and SameSite=Strict
 * and holds a random identifier only; sessions live in the server's memory and end with it.
 */
import { randomBytes } from 'node:crypto';

export const SESSION_COOKIE = 'docedit_demo_session';

/** How long a demo session lasts without use: a setting, not a measurement (ADR 0048). */
export const SESSION_IDLE_MS = 8 * 60 * 60 * 1000;

export interface DemoSession {
  sub: string;
  createdAt: number;
  usedAt: number;
}

/** The path every page and API route of `sub` lives under, and the cookie's path. */
export function userPath(sub: string): string {
  return `/as/${encodeURIComponent(sub)}`;
}

export class Sessions {
  readonly #sessions = new Map<string, DemoSession>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  create(sub: string): string {
    const id = randomBytes(32).toString('base64url');
    const t = this.#now();
    this.#sessions.set(id, { sub, createdAt: t, usedAt: t });
    return id;
  }

  /** The person of a session, if the session exists, is fresh and belongs to `sub`. */
  check(id: string | undefined, sub: string): DemoSession | null {
    if (!id) return null;
    const s = this.#sessions.get(id);
    if (!s) return null;
    const t = this.#now();
    if (t - s.usedAt > SESSION_IDLE_MS) {
      this.#sessions.delete(id);
      return null;
    }
    if (s.sub !== sub) return null;
    s.usedAt = t;
    return { ...s };
  }

  end(id: string | undefined): void {
    if (id) this.#sessions.delete(id);
  }
}
