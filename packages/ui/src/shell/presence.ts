/**
 * Who is in the document, for the header (UX-026; 13 §5). Pure functions over the core's presence
 * view, which already holds only the sessions this user may see (ADR 0019).
 *
 * One person with several sessions is shown once (ADR 0041: the spec leaves it open); they count as
 * active when any of their sessions is.
 */
import type { PresencePeer } from '../core-api.ts';

export interface PresentPerson {
  readonly user: string;
  /** The name the service reported for one of the sessions, if any. */
  readonly serviceName: string | null;
  readonly status: 'active' | 'idle';
  readonly sessions: number;
}

/** Groups sessions by user, in the order people first appear. */
export function peopleOf(peers: readonly PresencePeer[]): PresentPerson[] {
  const byUser = new Map<
    string,
    { serviceName: string | null; active: boolean; sessions: number }
  >();
  for (const peer of peers) {
    if (typeof peer.user !== 'string' || peer.user.length === 0) continue;
    const seen = byUser.get(peer.user);
    const name = typeof peer.name === 'string' && peer.name.trim() ? peer.name.trim() : null;
    if (seen) {
      seen.active ||= peer.status === 'active';
      seen.serviceName ??= name;
      seen.sessions++;
    } else
      byUser.set(peer.user, { serviceName: name, active: peer.status === 'active', sessions: 1 });
  }
  return [...byUser].map(([user, p]) => ({
    user,
    serviceName: p.serviceName,
    status: p.active ? 'active' : 'idle',
    sessions: p.sessions,
  }));
}

/**
 * How many avatars to show in `available` pixels, keeping room for the overflow button when not
 * everyone fits. Never fewer than zero; everyone when everyone fits.
 */
export function visibleAvatars(
  count: number,
  available: number,
  avatarWidth: number,
  gap: number,
  overflowWidth: number,
): number {
  if (count <= 0) return 0;
  if (!(available > 0) || !(avatarWidth > 0)) return count;
  const all = count * avatarWidth + (count - 1) * gap;
  if (all <= available) return count;
  const room = available - overflowWidth - gap;
  return Math.max(0, Math.min(count, Math.floor((room + gap) / (avatarWidth + gap))));
}

/** Up to two initials from a name, for an avatar without an image. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  const letters = words.length > 1 ? [words[0]!, words[words.length - 1]!] : words.slice(0, 1);
  return letters
    .map((w) => [...w][0] ?? '')
    .join('')
    .toLocaleUpperCase();
}

/** A stable colour slot (1 to `slots`) for a user, from the identifier, so it never depends on order. */
export function colourSlot(user: string, slots = 8): number {
  let hash = 0;
  for (const ch of user) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
  return (hash % slots) + 1;
}
