// PRM-052 criterion 3 (07 §9, §14): a session revocation is on the audit trail with the actor,
// the user revoked, the document when one is given, and the server time. Lane U-PRM-052-067.
// Runs on the in-memory store and on PostgreSQL when the integration environment is up.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`PRM-052 session revocation audit (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage);
    });
    afterAll(async () => {
      await h?.close();
    });

    it.skipIf(skip)(
      'records each revocation with its actor, user, document and server time, and serves it on GET /audit',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const before = h.now();

        const scoped = await h.call('POST', '/v1/sessions/revoke', {
          token: h.apiKey,
          body: { sub: 'zoe', doc },
        });
        expect(scoped.status, scoped.text).toBe(204);
        const whole = await h.call('POST', '/v1/sessions/revoke', {
          token: h.apiKey,
          body: { sub: 'yan' },
        });
        expect(whole.status).toBe(204);
        const after = h.now();

        const events = await h.parts.audit!.query(h.tenant, { kind: 'session.revoke', limit: 100 });
        expect(events).toHaveLength(2);
        const withDoc = events.find((e) => e.doc === doc);
        const whole2 = events.find((e) => e.doc === null);
        expect(withDoc).toBeDefined();
        expect(whole2).toBeDefined();
        for (const e of events) {
          expect(e.tenant).toBe(h.tenant);
          expect(e.actor).toBe('system');
          expect(e.at).toBeGreaterThanOrEqual(before);
          expect(e.at).toBeLessThanOrEqual(after);
          // The user revoked is named by surrogate, never by the host's identifier.
          expect(typeof e.data['subject']).toBe('string');
          expect(e.data['subject']).not.toBe('zoe');
          expect(e.data['subject']).not.toBe('yan');
        }

        // The audit route serves the same entries to the tenant's service credential.
        const page = await h.call('GET', '/v1/audit?kind=session.revoke', { token: h.apiKey });
        expect(page.status).toBe(200);
        const items = page.json.items as Array<{
          document: string | null;
          kind: string;
          actor: string;
        }>;
        expect(items, JSON.stringify(page.json)).toHaveLength(2);
        expect(items.every((i) => i.kind === 'session.revoke' && i.actor === 'system')).toBe(true);
        expect(items.map((i) => i.document).sort()).toEqual([doc, null].sort());
      },
    );
  });
}
