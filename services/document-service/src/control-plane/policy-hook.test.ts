// The data-loss prevention hook request (UX-086 criterion 4: signed the same way as webhooks).
// The sender, the timeout and the calls in the export and send paths are not built here.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decisionOf, hookRequest, type HookRequestInput } from './policy-hook.ts';
import { generateSecret, verifyDelivery, WEBHOOK_TOLERANCE_SECONDS } from './webhook-signing.ts';

const NOW = 1_800_000_000;

function input(over: Partial<HookRequestInput> = {}, secret = generateSecret()): HookRequestInput {
  return {
    id: 'msg-0001',
    timestamp: NOW,
    secrets: [secret],
    document: 'doc-1',
    actor: 'surrogate-olivia',
    action: 'export',
    target: 'pdf',
    classification: 'Confidential',
    ...over,
  };
}

describe('UX-086 criterion 4: the hook request is signed the same way as a webhook', () => {
  it('verifies with the reference verifier of webhooks, with the same secret', () => {
    const secret = generateSecret();
    const req = hookRequest(input({}, secret));
    expect(
      verifyDelivery({ headers: req.headers, body: req.body, secrets: [secret], now: NOW }),
    ).toEqual({
      ok: true,
    });
  });

  it('carries the document, the acting user, the action, the target and the label in the body', () => {
    const req = hookRequest(input());
    expect(JSON.parse(req.body)).toEqual({
      document: 'doc-1',
      actor: 'surrogate-olivia',
      action: 'export',
      target: 'pdf',
      classification: 'Confidential',
    });
    expect(req.headers['content-type']).toBe('application/json');
  });

  it('a body changed by one byte fails verification', () => {
    const secret = generateSecret();
    const req = hookRequest(input({}, secret));
    const tampered = req.body.replace('doc-1', 'doc-2');
    expect(
      verifyDelivery({ headers: req.headers, body: tampered, secrets: [secret], now: NOW }),
    ).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('a delivery older than the tolerance is refused', () => {
    const secret = generateSecret();
    const req = hookRequest(input({}, secret));
    expect(
      verifyDelivery({
        headers: req.headers,
        body: req.body,
        secrets: [secret],
        now: NOW + WEBHOOK_TOLERANCE_SECONDS + 1,
      }),
    ).toEqual({ ok: false, reason: 'timestamp_out_of_tolerance' });
  });

  it('during a rotation a receiver that knows either secret verifies it', () => {
    const older = generateSecret();
    const newer = generateSecret();
    const req = hookRequest(input({ secrets: [older, newer] }, older));
    for (const known of [older, newer])
      expect(
        verifyDelivery({ headers: req.headers, body: req.body, secrets: [known], now: NOW }),
      ).toEqual({
        ok: true,
      });
  });

  it('any body verifies under its own signature and fails once one character changes', () => {
    fc.assert(
      fc.property(
        // A label that is blank is refused by the request builder (nonEmpty), so only labels with a
        // visible character reach the signature.
        fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.trim() !== ''),
        fc.integer({ min: 0, max: 39 }),
        (label, at) => {
          const secret = generateSecret();
          const req = hookRequest(input({ classification: label }, secret));
          expect(
            verifyDelivery({ headers: req.headers, body: req.body, secrets: [secret], now: NOW }),
          ).toEqual({ ok: true });
          const i = at % req.body.length;
          const flipped =
            req.body.slice(0, i) + (req.body[i] === 'x' ? 'y' : 'x') + req.body.slice(i + 1);
          expect(
            verifyDelivery({ headers: req.headers, body: flipped, secrets: [secret], now: NOW }).ok,
          ).toBe(false);
        },
      ),
      { numRuns: 80 },
    );
  });

  it('a request with no label names none', () => {
    expect(JSON.parse(hookRequest(input({ classification: null })).body).classification).toBeNull();
  });

  it('refuses inputs that are not usable', () => {
    expect(() => hookRequest(input({ id: '' }))).toThrow(TypeError);
    expect(() => hookRequest(input({ document: ' ' }))).toThrow(TypeError);
    expect(() => hookRequest(input({ action: 'print' as never }))).toThrow(TypeError);
    expect(() => hookRequest(input({ secrets: [] }))).toThrow(TypeError);
  });
});

describe('UX-086: reading the hook answer', () => {
  it('reads allow and deny with its reason', () => {
    expect(decisionOf({ decision: 'allow' })).toEqual({ allow: true });
    expect(decisionOf({ decision: 'deny', reason: 'contains a customer list' })).toEqual({
      allow: false,
      reason: 'contains a customer list',
    });
  });

  it('gives null for any other shape: the caller decides what that means', () => {
    expect(decisionOf({ decision: 'deny' })).toBeNull();
    expect(decisionOf({ decision: 'deny', reason: '   ' })).toBeNull();
    expect(decisionOf({ decision: 'maybe' })).toBeNull();
    expect(decisionOf(['allow'])).toBeNull();
    expect(decisionOf(null)).toBeNull();
    expect(decisionOf({ decision: 'deny', reason: 'x'.repeat(501) })).toBeNull();
  });

  it('never reads a non-object answer as allow', () => {
    fc.assert(
      fc.property(fc.anything(), (v) => {
        const d = decisionOf(v);
        if (d !== null && d.allow) {
          expect(typeof v).toBe('object');
          expect((v as { decision?: unknown }).decision).toBe('allow');
        }
      }),
    );
  });
});
