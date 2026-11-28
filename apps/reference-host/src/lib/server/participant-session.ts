/**
 * The host's session for a participant who passed the passcode (UX-106). It stands in for the
 * host's own sign-in, which a participant never has: the page behind an invitation link asks for a
 * passcode, and a right one starts this session. The cookie holds a random identifier only. It is
 * HttpOnly and SameSite=Strict, and scoped to the one invitation page, so no script can read it
 * and no other page sends it.
 *
 * The token reaches the editor through the host's token endpoint for this session, in a response
 * body (05 §3.1; 13 §11.1 item 1), never in an address or in the page's text. That is the spec's
 * mechanism; the Notes of UX-106 ask the owner whether a short-lived token in the page data is
 * wanted instead, and until it answers the host uses this one.
 *
 * Sessions live in the process's memory and end with it, as the demo's sign-in does. A real host
 * keeps them in its own store.
 */
import { createHash, randomBytes } from 'node:crypto';

export const PARTICIPANT_COOKIE = 'docedit_demo_participant';

/** How long a participant session lasts: a setting of the demo, not a measurement (ADR 0048). */
export const PARTICIPANT_SESSION_MS = 2 * 60 * 60 * 1000;

interface Held {
  /** The hash of the invitation reference the session was started through. */
  readonly invitation: string;
  readonly participant: string;
  /** When the passcode was accepted (seconds): what the token's `auth_time` says. */
  readonly authTime: number;
  readonly expiresAt: number;
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export class ParticipantSessions {
  readonly #held = new Map<string, Held>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Starts a session for the participant whose newest invitation has this reference. */
  start(reference: string, participant: string): string {
    const id = randomBytes(32).toString('base64url');
    const t = this.#now();
    this.#held.set(sha256(id), {
      invitation: sha256(reference),
      participant,
      authTime: Math.floor(t / 1000),
      expiresAt: t + PARTICIPANT_SESSION_MS,
    });
    return id;
  }

  /** The participant of a session, when it is fresh and was started through this reference. */
  check(
    id: string | undefined,
    reference: string,
  ): { participant: string; authTime: number } | null {
    if (!id) return null;
    const key = sha256(id);
    const held = this.#held.get(key);
    if (held === undefined) return null;
    if (this.#now() > held.expiresAt) {
      this.#held.delete(key);
      return null;
    }
    // A new invitation (a reminder, the next turn) changes the reference: the old session ends with it.
    if (held.invitation !== sha256(reference)) return null;
    return { participant: held.participant, authTime: held.authTime };
  }
}
