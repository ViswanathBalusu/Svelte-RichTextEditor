/**
 * PRO-070 criterion 1 (lane V-PRO-069-085): the signature of a delivery matches the Standard
 * Webhooks published test vector. The vector is the fixed case of the Standard Webhooks Python
 * library's tests (libraries/python/tests/test_webhooks.py in standard-webhooks/standard-webhooks,
 * fetched 2026-11-13): the secret, the message identifier, the timestamp, the payload and the
 * expected `v1,` signature below are copied from that file. It is independent of the HMAC this
 * test file recomputes, so a wrong signing input fails here even when signing and verifying agree.
 */
import { describe, expect, it } from 'vitest';
import { signDelivery, verifyDelivery } from './webhook-signing.ts';

const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const ID = 'msg_p5jXN8AQM9LWM0D4loKWxJek';
const TIMESTAMP = 1614265330;
const PAYLOAD = '{"test": 2432232314}';
const EXPECTED = 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=';

describe('PRO-070 criterion 1: Standard Webhooks published vector', () => {
  it('signs the vector payload to the published v1 signature', () => {
    const headers = signDelivery({
      id: ID,
      timestamp: TIMESTAMP,
      body: PAYLOAD,
      secrets: [SECRET],
    });
    expect(headers['webhook-id']).toBe(ID);
    expect(headers['webhook-timestamp']).toBe(String(TIMESTAMP));
    expect(headers['webhook-signature']).toBe(EXPECTED);
  });

  it('the reference verifier accepts the published vector at its own timestamp', () => {
    const result = verifyDelivery({
      headers: {
        'webhook-id': ID,
        'webhook-timestamp': String(TIMESTAMP),
        'webhook-signature': EXPECTED,
      },
      body: PAYLOAD,
      secrets: [SECRET],
      now: TIMESTAMP,
    });
    expect(result).toEqual({ ok: true });
  });

  it('a different secret with the same final character does not produce the published signature', () => {
    const headers = signDelivery({
      id: ID,
      timestamp: TIMESTAMP,
      body: PAYLOAD,
      secrets: ['whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSx'],
    });
    expect(headers['webhook-signature']).not.toBe(EXPECTED);
  });
});
