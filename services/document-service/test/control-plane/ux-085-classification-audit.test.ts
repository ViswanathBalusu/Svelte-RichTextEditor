// UX-085 criterion 4 (07 section 14): a change of the classification label is on the audit trail,
// with its previous value, and a PATCH that leaves the label as it was adds nothing. Served on
// GET /audit to the tenant's service credential. Runs on the in-memory store and on PostgreSQL
// when the integration environment is up. Lane U-UX-076-090.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`UX-085 classification label audit (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage);
    });
    afterAll(async () => {
      await h?.close();
    });

    const read = (doc: string) => h.call('GET', `/v1/documents/${doc}`, { token: h.apiKey });
    const patch = async (doc: string, body: Record<string, unknown>) => {
      const etag = (await read(doc)).headers.get('etag')!;
      return h.call('PATCH', `/v1/documents/${doc}`, {
        token: h.apiKey,
        body,
        headers: { 'If-Match': etag },
      });
    };

    it.skipIf(skip)(
      'audits each change of the label with its previous value, and not a PATCH that changes nothing',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const before = h.now();

        expect((await patch(doc, { classification: 'Confidential' })).status).toBe(200);
        // The same label again: no change, so no event.
        expect((await patch(doc, { classification: 'Confidential' })).status).toBe(200);
        expect((await patch(doc, { classification: null })).status).toBe(200);
        const after = h.now();

        const page = await h.call('GET', `/v1/audit?kind=classification.changed&document=${doc}`, {
          token: h.apiKey,
        });
        expect(page.status, page.text).toBe(200);
        const items = page.json.items as Array<{ document: string | null; kind: string }>;
        expect(items, JSON.stringify(page.json)).toHaveLength(2);
        expect(items.every((i) => i.document === doc && i.kind === 'classification.changed')).toBe(
          true,
        );

        // GET /audit returns fixed fields only (UX-081), so the values are read from the store.
        const events = (
          await h.parts.audit!.query(h.tenant, { kind: 'classification.changed', limit: 1000 })
        ).filter((e) => e.doc === doc);
        expect(events).toHaveLength(2);
        // The first change set the label from none; the second cleared it.
        expect(events[0]?.data).toMatchObject({ previous: null, label: 'Confidential' });
        expect(events[1]?.data).toMatchObject({ previous: 'Confidential', label: null });
        for (const e of events) {
          expect(e.actor).toBe('system');
          expect(e.at).toBeGreaterThanOrEqual(before);
          expect(e.at).toBeLessThanOrEqual(after);
        }
      },
    );
  });
}
