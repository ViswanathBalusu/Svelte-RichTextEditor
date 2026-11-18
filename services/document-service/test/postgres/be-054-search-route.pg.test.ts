// BE-054 criterion 2 (lane U-BE-043-056): `GET /search` on PostgreSQL. A service credential gets the
// hits of its own tenant only, with no visibility class and no text; a user token is refused with
// `forbidden` (the operation takes a service credential, and the handler checks the same); a query
// with no `q` or no positive `limit` is refused. The search tables are those of migration 0086 in a
// migrated database (createTestDatabase), read as the service role, so row-level security applies.
// Skips, with the reason, when PostgreSQL is not up (infra/test-env.ps1 up).
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Router } from '../../src/control-plane/router.ts';
import { PgSearchIndex } from '../../src/control-plane/search-index-pg.ts';
import { searchRoutes } from '../../src/control-plane/search-routes.ts';
import type { Kit } from '../../src/control-plane/kit.ts';
import type { Ctx } from '../../src/control-plane/pipeline.ts';
import {
  createTestDatabase,
  newTenant,
  postgresUnavailable,
  type TestDatabase,
} from '../support/env.ts';

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

const TENANT_A = newTenant();
const TENANT_B = newTenant();
/** A document identifier made from a short name, so that the cases read as they did. */
const D = (name: string): string => {
  const h = createHash('md5').update(name).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const para = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

/** A context as the pipeline hands it to a handler, with the query and the caller. */
function ctxFor(query: string, caller: Record<string, unknown>): Ctx {
  return {
    url: new URL(`https://docs.test/v1/search${query}`),
    caller,
    params: {},
  } as unknown as Ctx;
}

describe.skipIf(unavailable !== null)('BE-054 criterion 2 on PostgreSQL: GET /search', () => {
  let db: TestDatabase;
  let handler: ReturnType<typeof searchRoutes>['search'];

  beforeAll(async () => {
    db = await createTestDatabase();
    const index = new PgSearchIndex(db.service);
    await index.indexCheckpoint({
      tenant: TENANT_A,
      doc: D('doc-a1'),
      seq: 3,
      visibility: 'full',
      content: para('quarterly invoice total'),
    });
    await index.indexCheckpoint({
      tenant: TENANT_A,
      doc: D('doc-a2'),
      seq: 1,
      visibility: 'full',
      content: para('invoice draft invoice'),
    });
    // A restricted class of tenant A: its text must not be returned to a credential without a user.
    await index.indexCheckpoint({
      tenant: TENANT_A,
      doc: D('doc-a3'),
      seq: 2,
      visibility: 'restricted',
      content: para('invoice secret'),
    });
    // Another tenant's text with the same words: never returned to tenant A.
    await index.indexCheckpoint({
      tenant: TENANT_B,
      doc: D('doc-b1'),
      seq: 1,
      visibility: 'full',
      content: para('invoice from elsewhere'),
    });
    const kit = {
      d: {
        search: index,
        // The route reads each hit's externalId from the document row (UX-084).
        documents: {
          get: async (ref: { doc: string }) => ({ externalId: `ext-${ref.doc}`, deletedAt: null }),
        },
      },
    } as unknown as Kit;
    handler = searchRoutes(kit).search!;
  }, 120_000);

  afterAll(() => db?.drop(), 120_000);

  const serviceOf = (tenant: string) => ({
    kind: 'service',
    tenant,
    identity: null,
    actor: 'host',
    credential: 'key-u-be-043-056',
  });

  it('returns the caller tenant hits only, one per document, without class or text', async () => {
    const reply = await handler(ctxFor('?q=invoice&limit=10', serviceOf(TENANT_A)));
    expect(reply.status).toBe(200);
    const body = (reply.body as { items: Array<Record<string, unknown>> }).items;
    // Best first: doc-a2 holds invoice twice, so it scores higher than doc-a1. The length check
    // keeps an empty reply from passing the checks below.
    expect(body.length).toBe(2);
    expect(body.map((h) => h['doc'])).toEqual([D('doc-a2'), D('doc-a1')]);
    for (const h of body)
      expect(Object.keys(h).sort()).toEqual(['doc', 'externalId', 'score', 'seq']);
    expect(JSON.stringify(body)).not.toContain('secret');
    expect(JSON.stringify(body)).not.toContain('elsewhere');
  });

  it('pages by cursor in the same order as the first page (UX-084)', async () => {
    const first = await handler(ctxFor('?q=invoice&limit=1', serviceOf(TENANT_A)));
    const page1 = first.body as { items: Array<{ doc: string }>; nextCursor: string | null };
    expect(page1.items.map((h) => h.doc)).toEqual([D('doc-a2')]);
    expect(page1.nextCursor).not.toBeNull();
    const second = await handler(
      ctxFor(
        `?q=invoice&limit=1&cursor=${encodeURIComponent(page1.nextCursor!)}`,
        serviceOf(TENANT_A),
      ),
    );
    const page2 = second.body as { items: Array<{ doc: string }>; nextCursor: string | null };
    expect(page2.items.map((h) => h.doc)).toEqual([D('doc-a1')]);
    expect(page2.nextCursor).toBeNull();
  });

  it("finds the other tenant's document for that tenant only", async () => {
    const reply = await handler(ctxFor('?q=elsewhere&limit=10', serviceOf(TENANT_B)));
    expect((reply.body as { items: Array<{ doc: string }> }).items.map((h) => h.doc)).toEqual([
      D('doc-b1'),
    ]);
    const none = await handler(ctxFor('?q=elsewhere&limit=10', serviceOf(TENANT_A)));
    expect(none.body).toEqual({ items: [], nextCursor: null });
  });

  it('refuses a user token with forbidden (the handler keeps the pipeline rule)', async () => {
    const user = { kind: 'user', tenant: TENANT_A, identity: 'sub-1', actor: 'user:1' };
    await expect(handler(ctxFor('?q=invoice&limit=10', user))).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('refuses a query with no q, or a limit that is not a positive integer', async () => {
    for (const q of [
      '?limit=10',
      '?q=%20&limit=10',
      '?q=invoice',
      '?q=invoice&limit=0',
      '?q=invoice&limit=ten',
    ]) {
      await expect(handler(ctxFor(q, serviceOf(TENANT_A)))).rejects.toMatchObject({
        code: 'validation_failed',
      });
    }
  });

  it('is the operation the protocol defines, for service credentials only', () => {
    const match = new Router().match('GET', '/search', 'rest');
    expect(match).not.toBeNull();
    expect(match).not.toBe('method');
    if (match === null || match === 'method') return;
    expect(match.op.operationId).toBe('search');
    expect([...match.op.security]).toEqual(['service']);
  });
});
