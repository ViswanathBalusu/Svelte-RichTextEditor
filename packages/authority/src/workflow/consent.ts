/**
 * The consent acceptance that a participant gives before signing (12 §6.1 `consent`, §8.1 step 1;
 * FRW-044), as pure functions.
 *
 * - `recordConsent` builds the acceptance record. The text is the one the server holds for the
 *   workflow's `consent` (`textId` and `version`); the hash is computed here, on the server, from that
 *   text. The client supplies no hash: the function takes no hash argument.
 * - `checkConsentForSign` decides whether a sign request may proceed. It refuses when there is no
 *   recorded acceptance, when the acceptance belongs to another participant or another text version,
 *   or when the text the server holds now no longer has the recorded hash.
 *
 * The consent endpoint, the sign endpoint, the consent text store and the explicit accept control
 * are the workflow service's and the client's (FRW-044 criteria 1, 2, 3 at the endpoint, 4 and 5).
 * Where consent texts are stored, authored and localised is open (FRW-044 Open questions).
 */
import { SHA256_HEX_PATTERN, sha256HexBytes, utf8 } from '@docedit/model';

/** The identity of a consent text: the workflow's `consent.textId` and `consent.version`. */
export interface ConsentTextRef {
  readonly textId: string;
  readonly version: string;
}

/** A consent text as the server holds it. */
export interface ConsentText extends ConsentTextRef {
  readonly text: string;
}

/** An acceptance on record: what was accepted, by whom, when on the server, and the text's hash. */
export interface ConsentRecord extends ConsentTextRef {
  readonly participantId: string;
  readonly acceptedAtMs: number;
  readonly textHash: string;
}

export type ConsentVerdict =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

const hexRe = new RegExp(SHA256_HEX_PATTERN);

/** SHA-256 over the UTF-8 bytes of a consent text, in lower-case hex. */
export async function consentTextHash(text: string): Promise<string> {
  return sha256HexBytes(utf8(text));
}

function nonEmpty(name: string, v: string): void {
  if (typeof v !== 'string' || v.length === 0) throw new RangeError(`${name} is empty`);
}

/**
 * The acceptance record for `participantId` accepting `consent`, timed by the server clock
 * (`serverTimeMs`, milliseconds since the epoch). The hash is of the server's text, never of a value
 * the client sent.
 */
export async function recordConsent(
  consent: ConsentText,
  participantId: string,
  serverTimeMs: number,
): Promise<ConsentRecord> {
  nonEmpty('textId', consent.textId);
  nonEmpty('version', consent.version);
  nonEmpty('participantId', participantId);
  if (!Number.isSafeInteger(serverTimeMs) || serverTimeMs < 0)
    throw new RangeError('recordConsent: the server time is not a non-negative safe integer');
  const textHash = await consentTextHash(consent.text);
  if (!hexRe.test(textHash)) throw new RangeError('recordConsent: the hash is malformed');
  return {
    textId: consent.textId,
    version: consent.version,
    participantId,
    acceptedAtMs: serverTimeMs,
    textHash,
  };
}

/**
 * Whether a sign request by `participantId` may proceed. `current` is the text the server holds for
 * the workflow's consent now, and its hash is compared with the one recorded at acceptance.
 */
export async function checkConsentForSign(
  record: ConsentRecord | undefined,
  participantId: string,
  current: ConsentText,
): Promise<ConsentVerdict> {
  if (record === undefined)
    return { ok: false, reason: 'no consent is recorded for this participant' };
  if (record.participantId !== participantId)
    return { ok: false, reason: 'the consent recorded belongs to another participant' };
  if (record.textId !== current.textId || record.version !== current.version)
    return { ok: false, reason: 'the consent recorded is for another text or version' };
  if (record.textHash !== (await consentTextHash(current.text)))
    return { ok: false, reason: 'the consent text has changed since it was accepted' };
  return { ok: true };
}
