/**
 * Request helpers of the host's routes: the demo session of the person a path names (UX-092),
 * and the answers the host's API gives. Every route under `/as/<sub>/` calls `personOf` first: the
 * path says who the page acts as, and the HttpOnly session cookie, which the browser sends only on
 * that path, proves it was chosen in this browser.
 */
import { error, type Cookies } from '@sveltejs/kit';
import type { DirectoryUser } from './directory.ts';
import type { Host } from './host.ts';
import { SESSION_COOKIE } from './sessions.ts';

export function personOf(h: Host, cookies: Cookies, sub: string): DirectoryUser | null {
  const user = h.directory.user(sub);
  if (!user) return null;
  return h.sessions.check(cookies.get(SESSION_COOKIE), sub) ? user : null;
}

/** For the API routes: the person, or 401 so that the page shows the host's sign-in. */
export function requirePerson(h: Host, cookies: Cookies, sub: string): DirectoryUser {
  const user = personOf(h, cookies, sub);
  if (!user) error(401, 'Choose a person on the start page first.');
  return user;
}

export const NO_STORE = { 'Cache-Control': 'no-store' } as const;
