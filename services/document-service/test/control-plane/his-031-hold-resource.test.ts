// HIS-031 criterion 4, the placing half, in the composed service on memory and on PostgreSQL
// (lane V-HIS-017-032, 2026-11-13). A hold placed through the administration API is audited with
// its actor and time, and GET /documents/{id} answers `legalHold: true` for that document only.
// The release half is not built (no release operation exists in holds.ts), so the criterion as a
// whole stays unticked; this file covers what is set. Test values only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { skipReason, startHarness, type Harness, type Storage } from './support.ts';

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`a document shows a legal hold in force (${storage}; HIS-031 criterion 4)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;

    beforeAll(async () => {
      if (!skip) h = await startHarness(storage);
    });
    afterAll(async () => {
      await h?.close();
    });

    it.skipIf(skip)('shows no hold on a document that nobody has held', async () => {
      const doc = await h.createDocument();
      const r = await h.call('GET', `/v1/documents/${doc}`, { token: h.apiKey });
      expect(r.status, r.text).toBe(200);
      expect((r.json as { legalHold?: unknown }).legalHold).toBe(false);
    });

    it.skipIf(skip)(
      'shows the hold in force on the document it was placed on, and not on another',
      async () => {
        const held = await h.createDocument();
        const other = await h.createDocument();
        const placed = await h.call('POST', `/v1/documents/${held}/holds`, {
          token: h.apiKey,
          body: { reason: 'Matter 2026-44' },
        });
        expect(placed.status, placed.text).toBe(201);

        const a = await h.call('GET', `/v1/documents/${held}`, { token: h.apiKey });
        expect(a.status, a.text).toBe(200);
        expect((a.json as { legalHold?: unknown }).legalHold).toBe(true);

        const b = await h.call('GET', `/v1/documents/${other}`, { token: h.apiKey });
        expect((b.json as { legalHold?: unknown }).legalHold).toBe(false);
      },
    );

    it.skipIf(skip)(
      'audits the placement with its actor and its time, on that document',
      async () => {
        const doc = await h.createDocument();
        const before = Date.now() - 1_000;
        const placed = await h.call('POST', `/v1/documents/${doc}/holds`, {
          token: h.apiKey,
          body: { reason: 'Audit check' },
        });
        expect(placed.status, placed.text).toBe(201);
        const after = Date.now() + 1_000;

        const page = await h.call('GET', `/v1/audit?kind=hold.placed&document=${doc}&limit=50`, {
          token: h.apiKey,
        });
        expect(page.status, page.text).toBe(200);
        const items = (
          page.json as {
            items: Array<{ document: string | null; actor: string; kind: string; at: string }>;
          }
        ).items;
        expect(items.length).toBeGreaterThanOrEqual(1);
        for (const e of items) {
          expect(e.document).toBe(doc);
          expect(e.kind).toBe('hold.placed');
          expect(e.actor).toBe('system');
          const at = Date.parse(e.at);
          expect(at).toBeGreaterThanOrEqual(before);
          expect(at).toBeLessThanOrEqual(after);
        }
      },
    );
  });
}
