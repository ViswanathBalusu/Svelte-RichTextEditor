/**
 * How the host's claims about authentication are shown (10 §3.6; 12 §8.3; SEC-043 criterion 2).
 *
 * A token may carry `amr` (how the host authenticated the person) and `auth_time` (when). The
 * platform records them as given and never checks them (FRW-038). `presentAssertedAuthentication`
 * turns them into the one form the certificate of completion and the evidence record show: the
 * values, marked as asserted by the host, with the sentence that the platform did not check them.
 * It never uses the word "verified" for them and never calls them an identity.
 */
import { AUTHENTICATION_PHRASE } from './language.ts';

/** The claims as the host gave them. Either may be absent. */
export interface HostAuthenticationClaims {
  /** `amr` of the token: authentication method references, as given. */
  readonly amr?: readonly string[] | null;
  /** `auth_time` of the token: seconds since the Unix epoch, as given. */
  readonly authTimeSeconds?: number | null;
}

/** The presentation of the claims. `source` and `checked` are fixed: the values are never vouched for. */
export interface AssertedAuthentication {
  readonly source: 'host';
  readonly checked: false;
  readonly amr?: readonly string[];
  readonly authTimeSeconds?: number;
  /** The sentence the certificate prints. */
  readonly text: string;
}

const MAX_AMR_ENTRIES = 16;
const MAX_AMR_LENGTH = 64;

/** `2026-11-06 10:00:00 UTC` from seconds since the epoch. */
function utcOf(seconds: number): string {
  return `${new Date(seconds * 1000).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

/**
 * The presentation of `claims`, or `undefined` when the host gave neither claim (nothing is shown,
 * and nothing is invented). Throws a `RangeError` on a value that cannot be shown as given: an
 * `amr` entry that is not a short plain string, too many entries, or a time that is not a finite
 * number of seconds in the range of a date.
 */
export function presentAssertedAuthentication(
  claims: HostAuthenticationClaims,
): AssertedAuthentication | undefined {
  const amr = claims.amr ?? undefined;
  const at = claims.authTimeSeconds ?? undefined;
  if (amr === undefined && at === undefined) return undefined;
  const parts: string[] = [];
  if (amr !== undefined) {
    if (amr.length > MAX_AMR_ENTRIES)
      throw new RangeError(
        `presentAssertedAuthentication: more than ${MAX_AMR_ENTRIES} amr values`,
      );
    for (const m of amr) {
      // Printable ASCII only, so the sentence cannot carry markup or control characters.
      if (
        typeof m !== 'string' ||
        m.length === 0 ||
        m.length > MAX_AMR_LENGTH ||
        !/^[\x21-\x7e]+$/.test(m)
      )
        throw new RangeError(
          'presentAssertedAuthentication: an amr value is not a short plain string',
        );
    }
    parts.push(`amr: ${amr.length === 0 ? '(none)' : amr.join(', ')}`);
  }
  if (at !== undefined) {
    if (!Number.isFinite(at) || Number.isNaN(new Date(at * 1000).getTime()))
      throw new RangeError('presentAssertedAuthentication: auth_time is not a time in seconds');
    parts.push(`auth_time: ${utcOf(at)}`);
  }
  const out: {
    -readonly [K in keyof AssertedAuthentication]: AssertedAuthentication[K];
  } = {
    source: 'host',
    checked: false,
    text: `Authentication ${AUTHENTICATION_PHRASE} and recorded as given (${parts.join('; ')}). The platform did not check these values.`,
  };
  if (amr !== undefined) out.amr = [...amr];
  if (at !== undefined) out.authTimeSeconds = at;
  return out;
}
