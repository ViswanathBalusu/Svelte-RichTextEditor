// UX-080 criteria 2 and 3 (lane U-UX-076-090, round 4): legal holds placed through the administration
// API and listed by it, in the composed service, on memory and on PostgreSQL (table `document_holds`,
// migration 0066, under row-level security). The routes are POST /documents/{id}/holds and GET
// /holds; a hold records its reason, the actor and the time, and every placement is audited
// (`hold.placed`). The hold rule of HIS-031 (suspension and release) is not in this test: it needs
// `@docedit/history` in the service, which is a package.json change for the main session.
// Each run on PostgreSQL has a database of its own (createTestDatabase), dropped afterwards. Test
// values only.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgHoldStore } from '../../src/control-plane/holds-pg.ts';
import { checkHoldReason, HoldService, MemoryHoldStore } from '../../src/control-plane/holds.ts';
import { skipReason, startHarness, type Harness, type Storage } from './support.ts';

describe('the reason of a hold (UX-080 criterion 2)', () => {
  it('takes a reason, trimmed, and refuses anything else', () => {
    expect(checkHoldReason({ reason: '  Case 2026/41  ' })).toBe('Case 2026/41');
    for (const bad of [
      null,
      'a string',
      [],
      {},
      { reason: '' },
      { reason: '   ' },
      { reason: 42 },
      { reason: 'x'.repeat(501) },
      { reason: 'ok', extra: true },
    ]) {
      expect(() => checkHoldReason(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it('counts the reason in characters, so 500 are accepted', () => {
    expect(checkHoldReason({ reason: 'é'.repeat(500) })).toBe('é'.repeat(500));
    expect(() => checkHoldReason({ reason: 'é'.repeat(501) })).toThrow();
  });

  it('refuses an unknown document before storing anything', async () => {
    const store = new MemoryHoldStore();
    const service = new HoldService({
      store,
      audit: { record: async () => {}, query: async () => [] } as never,
      documentExists: async () => false,
      now: () => 1_700_000_000_000,
    });
    await expect(service.place('t', randomUUID(), 'system', { reason: 'r' })).rejects.toThrow();
    expect(await store.list('t', null, 10)).toEqual([]);
  });
});

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`legal holds in the composed service (${storage}; UX-080 criteria 2 and 3)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;

    beforeAll(async () => {
      if (!skip) h = await startHarness(storage);
    });
    afterAll(async () => {
      await h?.close();
    });

    it.skipIf(skip)('offers the routes: the parts compose a hold service', () => {
      expect(h.parts.holds).toBeDefined();
    });

    it.skipIf(skip)(
      'records the reason, the actor and the time of a hold on a document (criterion 2)',
      async () => {
        const doc = await h.createDocument();
        const placed = await h.call('POST', `/v1/documents/${doc}/holds`, {
          token: h.apiKey,
          body: { reason: '  Litigation hold, matter 2026-41  ' },
        });
        expect(placed.status, placed.text).toBe(201);
        const hold = placed.json as Record<string, unknown>;
        expect(hold['document']).toBe(doc);
        expect(hold['reason']).toBe('Litigation hold, matter 2026-41');
        expect(hold['placedBy']).toBe('system');
        expect(typeof hold['id']).toBe('string');
        expect(Number.isNaN(Date.parse(String(hold['placedAt'])))).toBe(false);
        expect(placed.headers.get('cache-control')).toBe('no-store');
      },
    );

    it.skipIf(skip)('refuses a hold without a usable reason, and stores nothing', async () => {
      const doc = await h.createDocument();
      for (const body of [{}, { reason: '' }, { reason: 'ok', owner: 'x' }]) {
        const r = await h.call('POST', `/v1/documents/${doc}/holds`, {
          token: h.apiKey,
          body,
        });
        expect(r.status, r.text).toBe(400);
      }
      const list = await h.call('GET', '/v1/holds?limit=200', { token: h.apiKey });
      const held = (list.json as { items: Array<{ document: string }> }).items;
      expect(held.some((x) => x.document === doc)).toBe(false);
    });

    it.skipIf(skip)('refuses an unknown document, and an identifier that is not one', async () => {
      const missing = '0190c9d8-0000-7000-8000-000000000000';
      const a = await h.call('POST', `/v1/documents/${missing}/holds`, {
        token: h.apiKey,
        body: { reason: 'r' },
      });
      expect(a.status).toBe(404);
      const b = await h.call('POST', '/v1/documents/not-a-document/holds', {
        token: h.apiKey,
        body: { reason: 'r' },
      });
      expect(b.status).toBe(404);
    });

    it.skipIf(skip)('refuses a user token: holds are the service credential only', async () => {
      const doc = await h.createDocument();
      const r = await h.call('POST', `/v1/documents/${doc}/holds`, {
        token: h.userToken({ [doc]: 'edit' }),
        body: { reason: 'r' },
      });
      expect(r.status).toBe(403);
    });

    it.skipIf(skip)(
      'lists every document under hold, a page at a time, and every hold of a document (criterion 3)',
      async () => {
        const docs = [await h.createDocument(), await h.createDocument(), await h.createDocument()];
        const placed: string[] = [];
        // The first document carries two holds: the list names both.
        for (const [doc, reason] of [
          [docs[0]!, 'first'],
          [docs[1]!, 'second'],
          [docs[0]!, 'third'],
          [docs[2]!, 'fourth'],
        ] as const) {
          const r = await h.call('POST', `/v1/documents/${doc}/holds`, {
            token: h.apiKey,
            body: { reason },
          });
          expect(r.status, r.text).toBe(201);
          placed.push(String((r.json as { id: string }).id));
        }

        const seen: Array<{ id: string; document: string; reason: string }> = [];
        let cursor: string | null = null;
        let pages = 0;
        do {
          const q = `/v1/holds?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
          const page = await h.call('GET', q, { token: h.apiKey });
          expect(page.status, page.text).toBe(200);
          const body = page.json as {
            items: Array<{ id: string; document: string; reason: string }>;
            nextCursor: string | null;
          };
          expect(body.items.length).toBeLessThanOrEqual(2);
          seen.push(...body.items);
          cursor = body.nextCursor;
          pages += 1;
        } while (cursor !== null && pages < 10);

        const ours = seen.filter((x) => placed.includes(x.id));
        expect(ours.map((x) => x.id).sort()).toEqual([...placed].sort());
        expect(new Set(ours.map((x) => x.document))).toEqual(new Set(docs));
        expect(
          ours
            .filter((x) => x.document === docs[0])
            .map((x) => x.reason)
            .sort(),
        ).toEqual(['first', 'third']);
        expect(pages).toBeGreaterThan(1);
      },
    );

    it.skipIf(skip)('refuses a cursor the server did not issue', async () => {
      const r = await h.call('GET', '/v1/holds?cursor=not-a-cursor', { token: h.apiKey });
      expect(r.status).toBe(400);
    });

    it.skipIf(skip)('refuses a limit above 200', async () => {
      const r = await h.call('GET', '/v1/holds?limit=201', { token: h.apiKey });
      expect(r.status).toBe(400);
    });

    it.skipIf(skip)('audits each placement as hold.placed with its reason', async () => {
      const page = await h.call('GET', '/v1/audit?kind=hold.placed&limit=200', {
        token: h.apiKey,
      });
      expect(page.status, page.text).toBe(200);
      const events = (page.json as { items: Array<{ kind?: string; data?: unknown }> }).items;
      expect(events.length).toBeGreaterThanOrEqual(5);
      for (const e of events) expect(e.kind).toBe('hold.placed');
    });

    it.skipIf(skip)(
      'keeps the placed holds on PostgreSQL, readable by a second store',
      async () => {
        if (storage !== 'postgres' || !h.db) return;
        const doc = await h.createDocument();
        const placed = await h.call('POST', `/v1/documents/${doc}/holds`, {
          token: h.apiKey,
          body: { reason: 'stored on PostgreSQL' },
        });
        expect(placed.status, placed.text).toBe(201);
        const id = (placed.json as { id: string }).id;

        const rows = await h.db.admin.query<{ reason: string; placed_by: string }>(
          `select reason, placed_by from document_holds where tenant_id = $1 and id = $2`,
          [h.tenant, id],
        );
        expect(rows.rows).toEqual([{ reason: 'stored on PostgreSQL', placed_by: 'system' }]);

        const afterRestart = new PgHoldStore(h.db.service);
        const listed = await afterRestart.list(h.tenant, null, 1000);
        expect(listed.some((r) => r.id === id && r.document === doc)).toBe(true);
      },
    );
  });
}
