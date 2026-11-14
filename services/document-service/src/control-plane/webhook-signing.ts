/**
 * Signatures of webhook requests (05 §7; 10 §3.2, §3.7; PRO-070), as the Standard Webhooks
 * specification describes them: three headers `webhook-id`, `webhook-timestamp` and
 * `webhook-signature`; the signed content is `<id>.<timestamp>.<body>`; the signature is
 * HMAC-SHA256 with the secret's key bytes, written as `v1,<base64>`.
 *
 * A secret has the form `whsec_<base64 of the key bytes>`. During a rotation two secrets are
 * active: the signature header then holds one `v1,` entry per secret, separated by a space, so a
 * receiver that knows either secret verifies the delivery. A receiver rejects a timestamp more than
 * five minutes from its own clock (`WEBHOOK_TOLERANCE_SECONDS`), and any change to one byte of the
 * body or the id breaks the signature.
 *
 * Nothing here sends a request. The dispatcher (BE-055) calls `signDelivery`; the reference
 * verifier is `verifyDelivery`.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** The five-minute tolerance of 05 §7, in seconds. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

const SECRET_PREFIX = 'whsec_';
const SIGNATURE_PREFIX = 'v1,';

export type SignedHeaders = {
  'webhook-id': string;
  /** Unix time in whole seconds. */
  'webhook-timestamp': string;
  /** One `v1,<base64>` entry per active secret, separated by spaces. */
  'webhook-signature': string;
};

/** A new secret: `whsec_` and 32 random bytes in base64. */
export function generateSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(32).toString('base64')}`;
}

/** The key bytes of a secret. A secret that is not of the form above is refused. */
export function keyOf(secret: string): Buffer {
  if (!secret.startsWith(SECRET_PREFIX)) throw new TypeError('a webhook secret starts with whsec_');
  const key = Buffer.from(secret.slice(SECRET_PREFIX.length), 'base64');
  if (key.length === 0) throw new TypeError('a webhook secret carries no key bytes');
  return key;
}

function signatureOf(key: Buffer, id: string, timestamp: number, body: string): Buffer {
  return createHmac('sha256', key).update(`${id}.${timestamp}.${body}`, 'utf8').digest();
}

export interface SignInput {
  /** The message identifier, the same on every retry of the delivery (PRO-071). */
  id: string;
  /** Unix time in whole seconds. */
  timestamp: number;
  /** The exact body bytes sent, as text. */
  body: string;
  /** The active secrets: one while stable, two during a rotation. */
  secrets: readonly string[];
}

export function signDelivery(input: SignInput): SignedHeaders {
  if (input.id.length === 0) throw new TypeError('a webhook needs a message identifier');
  if (!Number.isSafeInteger(input.timestamp) || input.timestamp < 0)
    throw new TypeError('the timestamp is whole seconds since the epoch');
  if (input.secrets.length === 0) throw new TypeError('at least one active secret is needed');
  const entries = input.secrets.map(
    (s) =>
      `${SIGNATURE_PREFIX}${signatureOf(keyOf(s), input.id, input.timestamp, input.body).toString('base64')}`,
  );
  return {
    'webhook-id': input.id,
    'webhook-timestamp': String(input.timestamp),
    'webhook-signature': entries.join(' '),
  };
}

export type VerifyFailure = 'missing_headers' | 'timestamp_out_of_tolerance' | 'bad_signature';

export type VerifyResult = { ok: true } | { ok: false; reason: VerifyFailure };

export interface VerifyInput {
  /** The request headers; names are matched without regard to case. */
  headers: Readonly<Record<string, string | undefined>>;
  body: string;
  /** Secrets the receiver knows. A delivery is accepted when one of them signed it. */
  secrets: readonly string[];
  /** The receiver's clock, Unix time in whole seconds. */
  now: number;
  toleranceSeconds?: number;
}

function header(headers: VerifyInput['headers'], name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === want) return v;
  return undefined;
}

/** The reference verifier of 05 §7: timestamp first, then a signature that matches a known secret. */
export function verifyDelivery(input: VerifyInput): VerifyResult {
  const id = header(input.headers, 'webhook-id');
  const ts = header(input.headers, 'webhook-timestamp');
  const sig = header(input.headers, 'webhook-signature');
  if (id === undefined || ts === undefined || sig === undefined || !/^\d+$/.test(ts))
    return { ok: false, reason: 'missing_headers' };
  const timestamp = Number(ts);
  const tolerance = input.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
  if (Math.abs(input.now - timestamp) > tolerance)
    return { ok: false, reason: 'timestamp_out_of_tolerance' };

  // The candidates the header offers: `v1,<base64>` entries of which only the v1 ones count.
  const offered = sig
    .split(' ')
    .filter((e) => e.startsWith(SIGNATURE_PREFIX))
    .map((e) => Buffer.from(e.slice(SIGNATURE_PREFIX.length), 'base64'));
  for (const secret of input.secrets) {
    const expected = signatureOf(keyOf(secret), id, timestamp, input.body);
    for (const got of offered) {
      if (got.length === expected.length && timingSafeEqual(got, expected)) return { ok: true };
    }
  }
  return { ok: false, reason: 'bad_signature' };
}
