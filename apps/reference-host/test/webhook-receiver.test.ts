// The webhook receiver of the reference host (UX-098, criteria 1, 2, 4 and 6): Standard Webhooks
// signatures with the five-minute tolerance, refusal of invalid deliveries, deduplication on
// `webhook-id` without assuming order, the response before the queued work runs, and rotation
// with two active secrets. Property-style cases use a seeded loop, because fast-check is not a
// dependency of this package (recorded in the story Notes).
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEDUPE_RETENTION_SECONDS,
  MemorySeenStore,
  WEBHOOK_TOLERANCE_SECONDS,
  WebhookReceiver,
  WorkQueue,
  decodeSecret,
  signatureFor,
  verifyWebhook,
  type ReceivedEvent,
} from '../src/lib/server/webhook-receiver.ts';

const NOW = 1_800_000_000;

function secretOf(bytes: Buffer): string {
  return `whsec_${bytes.toString('base64')}`;
}

const KEY_A = randomBytes(24);
const KEY_B = randomBytes(24);
const SECRET_A = secretOf(KEY_A);
const SECRET_B = secretOf(KEY_B);

function eventBody(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    specversion: '1.0',
    id: 'evt-1',
    source: '/documents/doc-1',
    type: 'dep.comment.mentioned.v1',
    subject: '0192f0a1-0000-7000-8000-000000000001',
    data: { seq: 7 },
    ...extra,
  });
}

/** Builds the headers a sender would for one delivery. */
function deliveryHeaders(
  id: string,
  timestamp: number,
  body: string,
  keys: Buffer[] = [KEY_A],
): Headers {
  const ts = String(timestamp);
  const sig = keys.map((k) => signatureFor(k, id, ts, body)).join(' ');
  return new Headers({ 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': sig });
}

describe('signature verification (criterion 1)', () => {
  it('accepts a delivery signed with the active secret', () => {
    const body = eventBody();
    const r = verifyWebhook({
      headers: deliveryHeaders('msg_1', NOW, body),
      body,
      secrets: [SECRET_A],
      nowSeconds: NOW,
    });
    expect(r).toEqual({ ok: true, id: 'msg_1', timestamp: NOW });
  });

  it('refuses a tampered body, a wrong secret and a missing header', () => {
    const body = eventBody();
    const headers = deliveryHeaders('msg_2', NOW, body);
    expect(
      verifyWebhook({
        headers,
        body: body.replace('"seq":7', '"seq":8'),
        secrets: [SECRET_A],
        nowSeconds: NOW,
      }),
    ).toEqual({ ok: false, reason: 'bad-signature' });
    expect(verifyWebhook({ headers, body, secrets: [SECRET_B], nowSeconds: NOW })).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
    const noSig = new Headers(headers);
    noSig.delete('webhook-signature');
    expect(verifyWebhook({ headers: noSig, body, secrets: [SECRET_A], nowSeconds: NOW })).toEqual({
      ok: false,
      reason: 'missing-headers',
    });
  });

  it('applies the five-minute tolerance in both directions', () => {
    const body = eventBody();
    const edge = (sent: number) =>
      verifyWebhook({
        headers: deliveryHeaders('msg_3', sent, body),
        body,
        secrets: [SECRET_A],
        nowSeconds: NOW,
      });
    expect(WEBHOOK_TOLERANCE_SECONDS).toBe(300);
    expect(edge(NOW - 300).ok).toBe(true);
    expect(edge(NOW + 300).ok).toBe(true);
    expect(edge(NOW - 301)).toEqual({ ok: false, reason: 'stale-timestamp' });
    expect(edge(NOW + 301)).toEqual({ ok: false, reason: 'stale-timestamp' });
  });

  it('refuses a timestamp that is not a plain integer', () => {
    const body = eventBody();
    const headers = new Headers({
      'webhook-id': 'msg_4',
      'webhook-timestamp': `${NOW}.5`,
      'webhook-signature': signatureFor(KEY_A, 'msg_4', `${NOW}.5`, body),
    });
    expect(verifyWebhook({ headers, body, secrets: [SECRET_A], nowSeconds: NOW })).toEqual({
      ok: false,
      reason: 'bad-timestamp',
    });
  });

  it('answers 401 for a bad signature and 400 for a malformed request, through the receiver', () => {
    const queue: ReceivedEvent[] = [];
    const receiver = new WebhookReceiver({
      secrets: () => [SECRET_A],
      seen: new MemorySeenStore(),
      queue: { push: (e) => queue.push(e) },
      now: () => NOW,
    });
    const body = eventBody();
    const forged = deliveryHeaders('msg_5', NOW, body, [KEY_B]);
    expect(receiver.receive(forged, body)).toEqual({ status: 401, reason: 'bad-signature' });
    expect(receiver.receive(new Headers(), body)).toEqual({
      status: 400,
      reason: 'missing-headers',
    });
    const badJson = 'not json';
    expect(receiver.receive(deliveryHeaders('msg_6', NOW, badJson), badJson)).toEqual({
      status: 400,
      reason: 'bad-json',
    });
    const noSubject = JSON.stringify({ type: 'dep.comment.mentioned.v1' });
    expect(receiver.receive(deliveryHeaders('msg_7', NOW, noSubject), noSubject)).toEqual({
      status: 400,
      reason: 'bad-event',
    });
    expect(queue).toEqual([]);
  });

  it('a secret must carry the whsec_ prefix and key bytes', () => {
    expect(() => decodeSecret('plain')).toThrow(/whsec_/);
    expect(() => decodeSecret('whsec_')).toThrow(/key bytes/);
    expect(decodeSecret(SECRET_A).equals(KEY_A)).toBe(true);
  });

  it('round-trips random bodies and rejects any single-byte change (seeded cases)', () => {
    for (let i = 0; i < 200; i++) {
      const key = randomBytes(1 + (i % 32));
      const secret = secretOf(key);
      const body = JSON.stringify({
        type: 'dep.task.assigned.v1',
        subject: 's',
        n: i,
        pad: 'x'.repeat(i),
      });
      const id = `msg_prop_${i}`;
      const headers = deliveryHeaders(id, NOW - (i % 300), body, [key]);
      expect(verifyWebhook({ headers, body, secrets: [secret], nowSeconds: NOW }).ok).toBe(true);
      const at = i % body.length;
      const flipped = body.slice(0, at) + (body[at] === 'a' ? 'b' : 'a') + body.slice(at + 1);
      expect(verifyWebhook({ headers, body: flipped, secrets: [secret], nowSeconds: NOW }).ok).toBe(
        false,
      );
    }
  });
});

describe('deduplication on webhook-id (criterion 2)', () => {
  it('queues one event when the same webhook-id arrives twice, and does not assume order', () => {
    const queue: ReceivedEvent[] = [];
    const receiver = new WebhookReceiver({
      secrets: () => [SECRET_A],
      seen: new MemorySeenStore(),
      queue: { push: (e) => queue.push(e) },
      now: () => NOW,
    });
    const first = eventBody({ id: 'evt-a', subject: 'doc-a' });
    const second = eventBody({ id: 'evt-b', subject: 'doc-b' });
    expect(receiver.receive(deliveryHeaders('msg_A', NOW, second), second)).toEqual({
      status: 202,
      duplicate: false,
    });
    expect(receiver.receive(deliveryHeaders('msg_B', NOW, first), first)).toEqual({
      status: 202,
      duplicate: false,
    });
    expect(receiver.receive(deliveryHeaders('msg_A', NOW + 60, second), second)).toEqual({
      status: 202,
      duplicate: true,
    });
    expect(queue.map((e) => e.webhookId)).toEqual(['msg_A', 'msg_B']);
  });

  it('forgets identifiers after the retention window, which covers 24 hours of retries', () => {
    expect(DEDUPE_RETENTION_SECONDS).toBe(24 * 3600 + 300);
    const seen = new MemorySeenStore();
    seen.add('old', NOW);
    seen.prune(NOW + DEDUPE_RETENTION_SECONDS);
    expect(seen.has('old')).toBe(true);
    seen.prune(NOW + DEDUPE_RETENTION_SECONDS + 1);
    expect(seen.has('old')).toBe(false);
  });

  it('does not remember a delivery that was refused, so a valid retry is still accepted', () => {
    const queue: ReceivedEvent[] = [];
    const seen = new MemorySeenStore();
    const receiver = new WebhookReceiver({
      secrets: () => [SECRET_A],
      seen,
      queue: { push: (e) => queue.push(e) },
      now: () => NOW,
    });
    const body = eventBody();
    receiver.receive(deliveryHeaders('msg_R', NOW, body, [KEY_B]), body);
    expect(seen.has('msg_R')).toBe(false);
    expect(receiver.receive(deliveryHeaders('msg_R', NOW, body), body).status).toBe(202);
    expect(queue).toHaveLength(1);
  });
});

describe('answering quickly, work afterwards (criterion 4)', () => {
  it('returns before the queued handler runs, and the handler runs on drain', async () => {
    const handled: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue = new WorkQueue(async (e) => {
      await gate;
      handled.push(e.webhookId);
    });
    const receiver = new WebhookReceiver({
      secrets: () => [SECRET_A],
      seen: new MemorySeenStore(),
      queue,
      now: () => NOW,
    });
    const body = eventBody();
    const outcome = receiver.receive(deliveryHeaders('msg_Q', NOW, body), body);
    expect(outcome).toEqual({ status: 202, duplicate: false });
    expect(queue.pending).toBe(1);
    expect(handled).toEqual([]);

    const drained = queue.drain();
    release();
    await drained;
    expect(handled).toEqual(['msg_Q']);
    expect(queue.pending).toBe(0);
  });

  it('keeps going after a failing handler and records the failure', async () => {
    const handled: string[] = [];
    const queue = new WorkQueue(async (e) => {
      if (e.webhookId === 'bad') throw new Error('mail sink down');
      handled.push(e.webhookId);
    });
    const body = eventBody();
    const receiver = new WebhookReceiver({
      secrets: () => [SECRET_A],
      seen: new MemorySeenStore(),
      queue,
      now: () => NOW,
    });
    receiver.receive(deliveryHeaders('bad', NOW, body), body);
    receiver.receive(deliveryHeaders('good', NOW, body), body);
    await queue.drain();
    expect(handled).toEqual(['good']);
    expect(queue.failures.map((f) => f.webhookId)).toEqual(['bad']);
  });
});

describe('secret rotation (criterion 6)', () => {
  it('accepts a delivery signed with either of two active secrets, and both at once', () => {
    const body = eventBody();
    const seen = new MemorySeenStore();
    const queue: ReceivedEvent[] = [];
    let active: string[] = [SECRET_A];
    const receiver = new WebhookReceiver({
      secrets: () => active,
      seen,
      queue: { push: (e) => queue.push(e) },
      now: () => NOW,
    });
    // Rotation begins: the new secret is added beside the old one.
    active = [SECRET_B, SECRET_A];
    expect(receiver.receive(deliveryHeaders('old_signed', NOW, body, [KEY_A]), body).status).toBe(
      202,
    );
    expect(receiver.receive(deliveryHeaders('new_signed', NOW, body, [KEY_B]), body).status).toBe(
      202,
    );
    // A sender that signs with both during the overlap is accepted once.
    expect(receiver.receive(deliveryHeaders('both', NOW, body, [KEY_A, KEY_B]), body).status).toBe(
      202,
    );
    // The old secret is retired: its signatures are refused, the new one still works.
    active = [SECRET_B];
    expect(receiver.receive(deliveryHeaders('retired', NOW, body, [KEY_A]), body).status).toBe(401);
    expect(receiver.receive(deliveryHeaders('after', NOW, body, [KEY_B]), body).status).toBe(202);
    expect(queue.map((e) => e.webhookId)).toEqual(['old_signed', 'new_signed', 'both', 'after']);
  });

  it('refuses every delivery when no secret is active', () => {
    const body = eventBody();
    const r = verifyWebhook({
      headers: deliveryHeaders('none', NOW, body),
      body,
      secrets: [],
      nowSeconds: NOW,
    });
    expect(r).toEqual({ ok: false, reason: 'no-secret' });
  });
});
