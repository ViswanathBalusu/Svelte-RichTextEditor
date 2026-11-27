// UX-078 criterion 1 and criterion 4 (audit of a change) in the composed service (lane
// V-UX-076-090, round 5): the harness starts the service with the parts `pgParts` and `memoryParts`
// build, so `/v1/quotas` runs over the quota store, the audit trail and the authentication the
// running service composes. On PostgreSQL the values are rows of `tenant_quotas` (migration 0069)
// and the change is an event in `audit_events`; the test reads both directly. Each PostgreSQL run
// has a database of its own (createTestDatabase), dropped afterwards. Test values only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgParts } from '../../src/server.ts';
import { skipReason, startHarness, type Harness, type Storage } from './support.ts';

const EMPTY = {
  connections: null,
  openDocuments: null,
  commitRate: null,
  roomCpuBudget: null,
  storage: null,
  exportConcurrency: null,
  exportMinutes: null,
  bulkSendRows: null,
};

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`/quotas in the composed service (${storage}; UX-078 criteria 1 and 4)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;

    beforeAll(async () => {
      if (!skip) h = await startHarness(storage);
    });
    afterAll(async () => {
      await h?.close();
    });

    it.skipIf(skip)('offers the routes: the parts compose a quota service', () => {
      expect(h.parts.quotaAdmin).toBeDefined();
    });

    it.skipIf(skip)(
      'reads unset quotas as null, sets some, keeps the others, and reads them back with a new ETag',
      async () => {
        const before = await h.call('GET', '/v1/quotas', { token: h.apiKey });
        expect(before.status, before.text).toBe(200);
        expect(before.json).toEqual(EMPTY);
        const etag0 = before.headers.get('etag');
        expect(etag0).toMatch(/^"[0-9a-f]{32}"$/);

        const set = await h.call('PUT', '/v1/quotas', {
          token: h.apiKey,
          body: { connections: 12, exportMinutes: 0 },
          headers: { 'If-Match': etag0! },
        });
        expect(set.status, set.text).toBe(200);
        expect(set.json).toEqual({ ...EMPTY, connections: 12, exportMinutes: 0 });
        const etag1 = set.headers.get('etag');
        expect(etag1).not.toBe(etag0);

        // A second PUT names one dimension: the others keep their value.
        const again = await h.call('PUT', '/v1/quotas', {
          token: h.apiKey,
          body: { commitRate: 60 },
          headers: { 'If-Match': etag1! },
        });
        expect(again.status, again.text).toBe(200);
        expect(again.json).toEqual({ ...EMPTY, connections: 12, exportMinutes: 0, commitRate: 60 });

        const read = await h.call('GET', '/v1/quotas', { token: h.apiKey });
        expect(read.json).toEqual(again.json);
        expect(read.headers.get('etag')).toBe(again.headers.get('etag'));
      },
    );

    it.skipIf(skip)(
      'refuses a missing or stale If-Match, and a bad body, and stores nothing for them',
      async () => {
        const read = await h.call('GET', '/v1/quotas', { token: h.apiKey });
        const etag = read.headers.get('etag')!;

        const missing = await h.call('PUT', '/v1/quotas', {
          token: h.apiKey,
          body: { storage: 5 },
        });
        expect(missing.status).toBe(428);
        const stale = await h.call('PUT', '/v1/quotas', {
          token: h.apiKey,
          body: { storage: 5 },
          headers: { 'If-Match': '"00000000000000000000000000000000"' },
        });
        expect(stale.status).toBe(412);

        for (const bad of [
          { storage: -1 },
          { storage: 2.5 },
          { storage: '5' },
          { storage: null },
          { bandwidth: 1 },
          ['storage'],
        ]) {
          const r = await h.call('PUT', '/v1/quotas', {
            token: h.apiKey,
            body: bad,
            headers: { 'If-Match': etag },
          });
          expect(r.status, JSON.stringify(bad)).toBe(400);
        }

        const after = await h.call('GET', '/v1/quotas', { token: h.apiKey });
        expect(after.headers.get('etag')).toBe(etag);
        expect(after.json.storage).toBeNull();
      },
    );

    it.skipIf(skip)('refuses a user token with forbidden', async () => {
      const r = await h.call('GET', '/v1/quotas', { token: h.userToken({}) });
      expect(r.status).toBe(403);
    });

    it.skipIf(skip)(
      'audits each change with its previous and new values, and no change not at all',
      async () => {
        const events = await h.parts.audit!.query(h.tenant, { kind: 'quota.changed', limit: 10 });
        // Two PUTs changed the settings; the refused ones and the reads changed nothing.
        expect(events).toHaveLength(2);
        const first = events.find(
          (e) =>
            (e.data as { settings: { connections: number | null } }).settings.connections === 12,
        );
        expect(first?.data).toEqual({
          previous: EMPTY,
          settings: { ...EMPTY, connections: 12, exportMinutes: 0 },
        });
        for (const e of events) {
          expect(e.doc).toBeNull();
          expect(e.actor).toBe('system');
        }

        // The same values again change nothing, so nothing is audited.
        const read = await h.call('GET', '/v1/quotas', { token: h.apiKey });
        const same = await h.call('PUT', '/v1/quotas', {
          token: h.apiKey,
          body: { commitRate: 60 },
          headers: { 'If-Match': read.headers.get('etag')! },
        });
        expect(same.status, same.text).toBe(200);
        expect(
          await h.parts.audit!.query(h.tenant, { kind: 'quota.changed', limit: 10 }),
        ).toHaveLength(2);

        if (!h.db) return;
        // PostgreSQL: the values are rows of the migrated table, and the service reads them back
        // through a second set of parts over the same database.
        const rows = await h.db.admin.query<{ dimension: string; value: number }>(
          'SELECT dimension, value FROM tenant_quotas WHERE tenant_id = $1 ORDER BY dimension',
          [h.tenant],
        );
        expect(rows.rows.map((r) => [r.dimension, Number(r.value)])).toEqual([
          ['commitRate', 60],
          ['connections', 12],
          ['exportMinutes', 0],
        ]);
        const again = pgParts(h.db.service).quotaAdmin!;
        expect(await again.get(h.tenant)).toEqual({
          ...EMPTY,
          connections: 12,
          exportMinutes: 0,
          commitRate: 60,
        });
      },
    );
  });
}
