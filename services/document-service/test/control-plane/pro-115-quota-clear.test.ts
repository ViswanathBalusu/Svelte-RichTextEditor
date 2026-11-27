// PRO-115, owner decision 267: a quota limit may be set to null (no limit), as the schema of
// `PUT /quotas` allows. The harness starts the composed service over memory, and over PostgreSQL
// where the Podman test environment is there (migration 0103 grants the delete). Test values only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { skipReason, startHarness, type Harness, type Storage } from './support.ts';

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`PUT /quotas clears a limit with null (${storage}; PRO-115, decision 267)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;

    beforeAll(async () => {
      if (!skip) h = await startHarness(storage);
    });
    afterAll(async () => {
      await h?.close();
    });

    const put = async (body: unknown) => {
      const read = await h.call('GET', '/v1/quotas', { token: h.apiKey });
      return h.call('PUT', '/v1/quotas', {
        token: h.apiKey,
        body,
        headers: { 'If-Match': read.headers.get('etag')! },
      });
    };

    it.skipIf(skip)('sets a limit, clears it, and reads no limit again', async () => {
      const set = await put({ connections: 5, commitRate: 9 });
      expect(set.status, set.text).toBe(200);
      const cleared = await put({ connections: null });
      expect(cleared.status, cleared.text).toBe(200);
      expect(cleared.json.connections).toBeNull();
      expect(cleared.json.commitRate).toBe(9);
      const read = await h.call('GET', '/v1/quotas', { token: h.apiKey });
      expect(read.json.connections).toBeNull();
      expect(read.json.commitRate).toBe(9);
    });

    it.skipIf(skip)(
      'clearing a limit that is not set changes nothing and is accepted',
      async () => {
        const r = await put({ storage: null });
        expect(r.status, r.text).toBe(200);
        expect(r.json.storage).toBeNull();
      },
    );

    it.skipIf(skip)('still refuses what is neither a whole number nor null', async () => {
      for (const bad of [{ storage: -1 }, { storage: 2.5 }, { storage: '5' }, { storage: {} }]) {
        const r = await put(bad);
        expect(r.status, JSON.stringify(bad)).toBe(400);
      }
    });

    it.skipIf(skip)('audits the clearing with the previous and the new values', async () => {
      const events = await h.parts.audit!.query(h.tenant, { kind: 'quota.changed', limit: 10 });
      const clearing = events.find(
        (e) =>
          (e.data as { previous: { connections: number | null } }).previous.connections === 5 &&
          (e.data as { settings: { connections: number | null } }).settings.connections === null,
      );
      expect(clearing).toBeDefined();
    });
  });
}
