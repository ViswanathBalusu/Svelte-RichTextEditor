// Signatures of webhook requests (05 §7; 10 §3.2, §3.7; PRO-070).
// Not covered here: the published Standard Webhooks test vectors (criterion 1 of PRO-070 stays
// open: the specification's vectors are not in this repository and were not fetched), and the
// dispatcher that signs real deliveries (BE-055).
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  WEBHOOK_TOLERANCE_SECONDS,
  generateSecret,
  keyOf,
  signDelivery,
  verifyDelivery,
} from './webhook-signing.ts';

const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const OTHER = 'whsec_c2Vjb25kLXNlY3JldC1rZXktYnl0ZXMtaGVyZQ==';
const ID = 'msg_p5jXN8AQM9LWM0D4loKWxJek';
const TS = 1_614_265_330;
const BODY = '{"specversion":"1.0","type":"dep.export.completed.v1"}';

function sigOf(secret: string, id: string, ts: number, body: string): string {
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  return createHmac('sha256', key).update(`${id}.${ts}.${body}`, 'utf8').digest('base64');
}

describe('PRO-070 every delivery carries the three signature headers', () => {
  it('sets webhook-id, webhook-timestamp and a v1 HMAC-SHA256 webhook-signature', () => {
    const h = signDelivery({ id: ID, timestamp: TS, body: BODY, secrets: [SECRET] });
    expect(h['webhook-id']).toBe(ID);
    expect(h['webhook-timestamp']).toBe(String(TS));
    expect(h['webhook-signature']).toBe(`v1,${sigOf(SECRET, ID, TS, BODY)}`);
  });

  it('signs the content id.timestamp.body, so a changed id or timestamp fails', () => {
    const h = signDelivery({ id: ID, timestamp: TS, body: BODY, secrets: [SECRET] });
    const headers = { ...h };
    expect(verifyDelivery({ headers, body: BODY, secrets: [SECRET], now: TS })).toEqual({
      ok: true,
    });
    expect(
      verifyDelivery({
        headers: { ...headers, 'webhook-id': 'msg_other' },
        body: BODY,
        secrets: [SECRET],
        now: TS,
      }),
    ).toEqual({ ok: false, reason: 'bad_signature' });
    expect(
      verifyDelivery({
        headers: { ...headers, 'webhook-timestamp': String(TS + 1) },
        body: BODY,
        secrets: [SECRET],
        now: TS + 1,
      }),
    ).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('refuses a secret that is not of the whsec_ form', () => {
    expect(() => keyOf('plain-secret')).toThrow(/whsec_/);
    expect(() => keyOf('whsec_')).toThrow();
  });

  it('generates secrets of the whsec_ form that differ between calls', () => {
    const a = generateSecret();
    const b = generateSecret();
    expect(a).toMatch(/^whsec_[A-Za-z0-9+/]+=*$/);
    expect(keyOf(a).length).toBe(32);
    expect(a).not.toBe(b);
  });
});

describe('PRO-070 a timestamp more than five minutes from the receiver clock is rejected', () => {
  const h = signDelivery({ id: ID, timestamp: TS, body: BODY, secrets: [SECRET] });

  it('accepts a delivery within five minutes, either side of the clock', () => {
    for (const now of [
      TS,
      TS + 299,
      TS - 299,
      TS + WEBHOOK_TOLERANCE_SECONDS,
      TS - WEBHOOK_TOLERANCE_SECONDS,
    ]) {
      expect(verifyDelivery({ headers: h, body: BODY, secrets: [SECRET], now })).toEqual({
        ok: true,
      });
    }
  });

  it('rejects a delivery more than five minutes old or from the future', () => {
    for (const now of [TS + 301, TS - 301, TS + 3600]) {
      expect(verifyDelivery({ headers: h, body: BODY, secrets: [SECRET], now })).toEqual({
        ok: false,
        reason: 'timestamp_out_of_tolerance',
      });
    }
  });

  it('checks the timestamp before the signature', () => {
    const forged = { ...h, 'webhook-signature': 'v1,AAAA' };
    expect(
      verifyDelivery({ headers: forged, body: BODY, secrets: [SECRET], now: TS + 400 }),
    ).toEqual({
      ok: false,
      reason: 'timestamp_out_of_tolerance',
    });
  });
});

describe('PRO-070 two secrets during a rotation: a signature for each', () => {
  const h = signDelivery({ id: ID, timestamp: TS, body: BODY, secrets: [SECRET, OTHER] });

  it('holds one v1 entry per active secret, separated by a space', () => {
    const parts = h['webhook-signature'].split(' ');
    expect(parts).toEqual([
      `v1,${sigOf(SECRET, ID, TS, BODY)}`,
      `v1,${sigOf(OTHER, ID, TS, BODY)}`,
    ]);
  });

  it('verifies with the old secret alone and with the new secret alone', () => {
    expect(verifyDelivery({ headers: h, body: BODY, secrets: [SECRET], now: TS })).toEqual({
      ok: true,
    });
    expect(verifyDelivery({ headers: h, body: BODY, secrets: [OTHER], now: TS })).toEqual({
      ok: true,
    });
  });

  it('refuses a receiver that knows neither secret', () => {
    const stranger = generateSecret();
    expect(verifyDelivery({ headers: h, body: BODY, secrets: [stranger], now: TS })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });
});

describe('PRO-070 a body changed by one byte fails verification', () => {
  const h = signDelivery({ id: ID, timestamp: TS, body: BODY, secrets: [SECRET] });

  it('fails for every single-byte change of the body', () => {
    const bytes = Buffer.from(BODY, 'utf8');
    for (let i = 0; i < bytes.length; i++) {
      const changed = Buffer.from(bytes);
      changed[i] = changed[i]! ^ 0x01;
      const result = verifyDelivery({
        headers: h,
        body: changed.toString('utf8'),
        secrets: [SECRET],
        now: TS,
      });
      expect(result.ok, `byte ${i}`).toBe(false);
    }
  });

  it('reports missing headers and a malformed timestamp', () => {
    expect(verifyDelivery({ headers: {}, body: BODY, secrets: [SECRET], now: TS })).toEqual({
      ok: false,
      reason: 'missing_headers',
    });
    expect(
      verifyDelivery({
        headers: { ...h, 'webhook-timestamp': 'yesterday' },
        body: BODY,
        secrets: [SECRET],
        now: TS,
      }),
    ).toEqual({ ok: false, reason: 'missing_headers' });
  });

  it('matches header names without regard to case', () => {
    const upper = {
      'Webhook-Id': h['webhook-id'],
      'WEBHOOK-TIMESTAMP': h['webhook-timestamp'],
      'Webhook-Signature': h['webhook-signature'],
    };
    expect(verifyDelivery({ headers: upper, body: BODY, secrets: [SECRET], now: TS })).toEqual({
      ok: true,
    });
  });
});

describe('PRO-070 signing refuses input that cannot be signed', () => {
  it('needs at least one active secret and a whole-second timestamp', () => {
    expect(() => signDelivery({ id: ID, timestamp: TS, body: BODY, secrets: [] })).toThrow(
      /secret/,
    );
    expect(() =>
      signDelivery({ id: ID, timestamp: TS + 0.5, body: BODY, secrets: [SECRET] }),
    ).toThrow(/whole seconds/);
  });
});
