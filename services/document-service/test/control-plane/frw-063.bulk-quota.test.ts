// FRW-063 criterion 4 through the real service: the tenant quota `bulkSendRows` (owner decision 265)
// limits the recipient rows a tenant submits in a UTC calendar month. A request that would take the
// month past it is refused with `quota_exceeded`, the kind `bulkSendRows` and a `Retry-After` to
// the start of next month, and queues no job. The rows used are the queue's, so `GET /usage` shows
// them. Memory storage and, when the test environment is up, PostgreSQL in Podman.
import { checkProblem } from '@docedit/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { secondsToNextMonth } from '../../src/control-plane/exp-009-compile-budget.ts';
import { MemoryQuotaStore } from '../../src/control-plane/quotas.ts';
import {
  skipReason,
  startHarness,
  documentWithRegions,
  type Harness,
  type Storage,
} from './support.ts';

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `Recipient ${i}` }));

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`the monthly limit on bulk send rows (${storage}; FRW-063 criterion 4)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    let quotas: MemoryQuotaStore;
    beforeAll(async () => {
      if (skip) return;
      quotas = new MemoryQuotaStore(() => true);
      h = await startHarness(storage, {
        realDataPlane: true,
        parts: { quotas },
        config: { jobIdleMs: 20 },
      });
    }, 60_000);
    afterAll(async () => {
      await h?.close();
    });

    const call = (method: string, path: string, body?: unknown, headers = {}) =>
      h.call(method, `/v1${path}`, {
        token: h.serviceJwt(),
        ...(body !== undefined ? { body } : {}),
        headers,
      });

    async function newTemplate(): Promise<string> {
      const doc = await h.createDocument({ content: documentWithRegions() });
      const made = await call('POST', '/templates', { document: doc, name: 'Lease' });
      expect(made.status, made.text).toBe(201);
      return made.json.id as string;
    }

    it.skipIf(skip)(
      'refuses a request that would pass the tenant’s rows for the month, names the quota, and queues no job',
      async () => {
        const template = await newTemplate();
        quotas.set(h.tenant, 'bulkSendRows', 5);

        const first = await call('POST', '/bulk-sends', { template, rows: rows(3) });
        expect(first.status, first.text).toBe(202);
        const usage = async () => (await h.call('GET', '/v1/usage', { token: h.apiKey })).json;
        expect((await usage()).bulkSendRows).toBe(3);

        // Three more would make six, past the five: refused, whole, and nothing is queued.
        const before = h.now();
        const refused = await call('POST', '/bulk-sends', { template, rows: rows(3) });
        const after = h.now();
        expect(refused.status, refused.text).toBe(429);
        expect(refused.json.code).toBe('quota_exceeded');
        expect(refused.json.quota).toBe('bulkSendRows');
        expect(
          checkProblem({
            surface: 'rest',
            code: refused.json.code,
            retryAfterHeader: refused.headers.get('retry-after') ?? undefined,
          }),
        ).toEqual([]);
        const retryAfter = Number(refused.headers.get('retry-after'));
        expect(retryAfter).toBeGreaterThanOrEqual(secondsToNextMonth(after));
        expect(retryAfter).toBeLessThanOrEqual(secondsToNextMonth(before));
        expect((await usage()).bulkSendRows, 'a refused request is not counted').toBe(3);

        // Two more make exactly five: allowed. One more is then refused.
        expect((await call('POST', '/bulk-sends', { template, rows: rows(2) })).status).toBe(202);
        expect((await usage()).bulkSendRows).toBe(5);
        const over = await call('POST', '/bulk-sends', { template, rows: rows(1) });
        expect(over.status).toBe(429);
        expect(over.json.quota).toBe('bulkSendRows');
      },
      60_000,
    );

    it.skipIf(skip)(
      'counts the rows of the month asked for only, and a figure far above the rows allows the request',
      async () => {
        const template = await newTemplate();
        quotas.set(h.tenant, 'bulkSendRows', 1_000_000);
        expect((await call('POST', '/bulk-sends', { template, rows: rows(2) })).status).toBe(202);
        // A month other than the current one has no rows of this tenant.
        const past = await h.call('GET', '/v1/usage?month=2020-01', { token: h.apiKey });
        expect(past.json.bulkSendRows).toBe(0);
      },
      60_000,
    );

    it.skipIf(skip)(
      'two requests of one tenant at once do not both pass the same month’s figure',
      async () => {
        const template = await newTemplate();
        const used = (await h.call('GET', '/v1/usage', { token: h.apiKey })).json
          .bulkSendRows as number;
        quotas.set(h.tenant, 'bulkSendRows', used + 4);
        const results = await Promise.all([
          call('POST', '/bulk-sends', { template, rows: rows(3) }),
          call('POST', '/bulk-sends', { template, rows: rows(3) }),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([202, 429]);
      },
      60_000,
    );
  });
}
