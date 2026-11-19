/**
 * The kit's own verifier of a webhook request (05 §7; Standard Webhooks). It is written here, from
 * the specification, and shares nothing with a server: the signed content is `<id>.<timestamp>.<body>`,
 * the signature is HMAC-SHA256 under the key bytes of a secret `whsec_<base64>`, and the header lists
 * one `v1,<base64>` entry per active secret, separated by spaces. A timestamp more than five minutes
 * from the receiver's clock is refused.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** The five-minute tolerance of 05 §7, in seconds. */
export const TOLERANCE_SECONDS = 300;

export type Verdict =
  | { readonly ok: true; readonly id: string; readonly timestamp: number; readonly entries: number }
  | { readonly ok: false; readonly reason: string };

/** The key bytes of a `whsec_` secret. */
export function keyBytes(secret: string): Buffer {
  if (!secret.startsWith('whsec_')) throw new Error('a webhook secret starts with whsec_');
  return Buffer.from(secret.slice('whsec_'.length), 'base64');
}

/**
 * Checks one request against the secrets the receiver knows. `now` is the receiver's clock in whole
 * seconds. `entries` is the number of `v1` signatures the header carried.
 */
export function verifyRequest(input: {
  headers: Readonly<Record<string, string>>;
  body: string;
  secrets: readonly string[];
  now: number;
}): Verdict {
  const id = input.headers['webhook-id'];
  const ts = input.headers['webhook-timestamp'];
  const sig = input.headers['webhook-signature'];
  if (!id || !ts || !sig || !/^\d+$/.test(ts))
    return { ok: false, reason: 'webhook-id, webhook-timestamp or webhook-signature is missing' };
  const timestamp = Number(ts);
  if (Math.abs(input.now - timestamp) > TOLERANCE_SECONDS)
    return { ok: false, reason: `the timestamp ${ts} is more than five minutes from now` };
  const offered = sig
    .split(' ')
    .filter((e) => e.startsWith('v1,'))
    .map((e) => Buffer.from(e.slice(3), 'base64'));
  for (const secret of input.secrets) {
    const expected = createHmac('sha256', keyBytes(secret))
      .update(`${id}.${timestamp}.${input.body}`, 'utf8')
      .digest();
    if (offered.some((g) => g.length === expected.length && timingSafeEqual(g, expected)))
      return { ok: true, id, timestamp, entries: offered.length };
  }
  return { ok: false, reason: 'no signature of the header matches a secret the receiver knows' };
}
