// The retention of idempotency keys at its specified value (05 §6.1: 24 hours; PRO-043 criterion 4;
// BE-034 criterion 5), over real HTTP, in memory and with PostgreSQL. The service runs with the
// configuration of an empty environment, so the retention is the default of `config.ts`, not a
// shortened one: a key is still answered from its first response just before 24 hours and is new
// just after. In test mode the shortened retention is the one `GET /_test/timers` reports (BE-079),
// which is the value the conformance kit reads (PRO-109).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from '../../test/control-plane/support.ts';
import { configFromEnv } from '../config.ts';
import { TEST_TIMERS } from './test-hooks.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('the default retention of idempotency keys', () => {
  it('is 24 hours, and the environment can change it', () => {
    expect(configFromEnv({}).idempotencyTtlMs).toBe(DAY_MS);
    expect(configFromEnv({ DOCEDIT_IDEMPOTENCY_TTL_MS: '60000' }).idempotencyTtlMs).toBe(60_000);
  });
});

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`idempotency key retention (${storage})`, async () => {
    const skip = await skipReason(storage);

    describe('with the default configuration', () => {
      let h: Harness;
      beforeAll(async () => {
        // No idempotencyTtlMs here: the service takes the default of an empty environment.
        if (!skip) h = await startHarness(storage);
      });
      afterAll(async () => {
        await h?.close();
      });

      it.skipIf(skip)(
        'replays a key used just under 24 hours earlier and treats one used 24 hours earlier as new (PRO-043 criterion 4)',
        async () => {
          const key = `k-${randomUUID()}`;
          const body = { title: 'day old' };
          const create = () =>
            h.call('POST', '/v1/documents', {
              token: h.apiKey,
              body,
              headers: { 'Idempotency-Key': key },
            });
          const first = await create();
          expect(first.status).toBe(201);
          // A minute before the retention ends the key still answers with the first response.
          h.advance(DAY_MS - 60_000);
          const within = await create();
          expect(within.status).toBe(201);
          expect(within.json.id).toBe(first.json.id);
          expect(within.headers.get('dep-idempotent-replayed')).toBe('true');
          // 24 hours after the first use the key is new: a second document, not a replay.
          h.advance(60_000);
          const after = await create();
          expect(after.status).toBe(201);
          expect(after.json.id).not.toBe(first.json.id);
          expect(after.headers.get('dep-idempotent-replayed')).toBeNull();
        },
      );
    });

    describe('in test mode', () => {
      let h: Harness;
      beforeAll(async () => {
        if (!skip)
          h = await startHarness(storage, { config: { testMode: true, environment: 'test' } });
      });
      afterAll(async () => {
        await h?.close();
      });

      it.skipIf(skip)(
        'reports the shortened retention at /_test/timers and keeps a key for that long only (PRO-043 criterion 4; BE-079)',
        async () => {
          const timers = await h.call('GET', '/_test/timers', { token: h.apiKey });
          expect(timers.status).toBe(200);
          const ttl = timers.json.idempotencyTtlMs as number;
          expect(ttl).toBe(TEST_TIMERS.idempotencyTtlMs);
          expect(ttl).toBeLessThan(DAY_MS);
          const key = `k-${randomUUID()}`;
          const create = () =>
            h.call('POST', '/v1/documents', {
              token: h.apiKey,
              body: { title: 'short' },
              headers: { 'Idempotency-Key': key },
            });
          const first = await create();
          expect(first.status).toBe(201);
          const within = await create();
          expect(within.json.id).toBe(first.json.id);
          h.advance(ttl);
          const after = await create();
          expect(after.status).toBe(201);
          expect(after.json.id).not.toBe(first.json.id);
          expect(after.headers.get('dep-idempotent-replayed')).toBeNull();
        },
      );
    });
  });
}
