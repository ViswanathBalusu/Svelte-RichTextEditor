// The audit query of GET /audit (UX-081), at the operation level, over the in-memory audit store
// the data plane tests use. The route itself is tested over HTTP in
// test/control-plane/routes.audit.test.ts.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MemoryAudit } from '../data-plane/memory-ports.ts';
import type { AuditEvent } from '../storage/types.ts';
import { AUDIT_MAX_LIMIT, AuditQueryService, encodeCursor, type AuditPage } from './audit-query.ts';
import type { Caller } from './pipeline.ts';
import { ApiError } from './problems.ts';

const TENANT = 'tenant-a';
const service = (tenant = TENANT): Caller => ({
  kind: 'service',
  tenant,
  identity: null,
  actor: 'system',
  credential: 'key-1',
});
const user: Caller = {
  kind: 'user',
  tenant: TENANT,
  identity: null as never,
  actor: 'user-surrogate-1',
  credential: 'user',
};

const BASE = Date.parse('2026-11-13T09:00:00.000Z');

function event(n: number, over: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: `ev-${String(n).padStart(6, '0')}`,
    tenant: TENANT,
    doc: 'doc-1',
    actor: 'actor-1',
    kind: 'commit.rejected',
    data: { scopes: ['text.write'] },
    at: BASE + n,
    ...over,
  };
}

async function seeded(events: AuditEvent[]) {
  const store = new MemoryAudit();
  await store.record(events);
  return { store, query: new AuditQueryService({ store }) };
}

async function page(
  query: AuditQueryService,
  params: Record<string, string | undefined>,
  caller: Caller = service(),
): Promise<AuditPage> {
  const answer = await query.query(caller, params);
  expect(answer.status).toBe(200);
  return answer.body as AuditPage;
}

async function refused(
  query: AuditQueryService,
  params: Record<string, string | undefined>,
  caller: Caller = service(),
): Promise<ApiError> {
  try {
    await query.query(caller, params);
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error('the query was not refused');
}

describe('UX-081 criterion 3: only a service credential may query', () => {
  it('refuses a user token with forbidden', async () => {
    const { query } = await seeded([event(1)]);
    const e = await refused(query, {}, user);
    expect(e.code).toBe('forbidden');
  });
});

describe('UX-081 criterion 1 (part): each event carries actor, document, scopes and server time', () => {
  it('returns those fields in ISO time', async () => {
    const { query } = await seeded([event(1, { data: { scopes: ['doc.read', 'doc.write'] } })]);
    const body = await page(query, {});
    expect(body.items).toEqual([
      {
        id: 'ev-000001',
        document: 'doc-1',
        actor: 'actor-1',
        kind: 'commit.rejected',
        scopes: ['doc.read', 'doc.write'],
        at: new Date(BASE + 1).toISOString(),
      },
    ]);
    expect(body.nextCursor).toBeNull();
  });
});

describe('UX-081 criterion 6: no document content and no token in a returned event', () => {
  it('keeps only the scopes of the data, whatever else the event carries', async () => {
    const { query } = await seeded([
      event(1, {
        data: { scopes: ['x'], content: 'the words of the document', token: 'eyJhbGciOi.secret' },
      }),
    ]);
    const [item] = (await page(query, {})).items;
    expect(Object.keys(item!).sort()).toEqual(['actor', 'at', 'document', 'id', 'kind', 'scopes']);
    expect(JSON.stringify(item)).not.toContain('the words of the document');
    expect(JSON.stringify(item)).not.toContain('eyJhbGciOi');
  });

  it('drops scopes that are not a list of strings', async () => {
    const { query } = await seeded([event(1, { data: { scopes: 'text.write' } })]);
    expect((await page(query, {})).items[0]!.scopes).toEqual([]);
  });
});

describe('UX-081 criterion 2: filters and cursor paging', () => {
  it('filters by document, actor, kind and a time range (from inclusive, to exclusive)', async () => {
    const { query } = await seeded([
      event(1, { doc: 'doc-1', actor: 'a', kind: 'commit.rejected' }),
      event(2, { doc: 'doc-2', actor: 'a', kind: 'commit.rejected' }),
      event(3, { doc: 'doc-1', actor: 'b', kind: 'commit.rejected' }),
      event(4, { doc: 'doc-1', actor: 'a', kind: 'grants.changed' }),
      event(5, { doc: 'doc-1', actor: 'a', kind: 'commit.rejected' }),
    ]);
    const ids = async (p: Record<string, string | undefined>) =>
      (await page(query, p)).items.map((i) => i.id);
    expect(await ids({ document: 'doc-1' })).toEqual([
      'ev-000001',
      'ev-000003',
      'ev-000004',
      'ev-000005',
    ]);
    expect(await ids({ actor: 'a' })).toEqual(['ev-000001', 'ev-000002', 'ev-000004', 'ev-000005']);
    expect(await ids({ kind: 'grants.changed' })).toEqual(['ev-000004']);
    const from = new Date(BASE + 2).toISOString();
    const to = new Date(BASE + 4).toISOString();
    expect(await ids({ from, to })).toEqual(['ev-000002', 'ev-000003']);
  });

  it('refuses a limit above 200, zero, or a non-number', async () => {
    const { query } = await seeded([event(1)]);
    for (const limit of ['201', '0', 'many', '-1']) {
      const e = await refused(query, { limit });
      expect(e.code).toBe('validation_failed');
    }
    expect((await page(query, { limit: String(AUDIT_MAX_LIMIT) })).items).toHaveLength(1);
  });

  it('refuses an unknown parameter, a bad time and a range that ends before it starts', async () => {
    const { query } = await seeded([event(1)]);
    expect((await refused(query, { tenant: 'tenant-b' })).code).toBe('validation_failed');
    expect((await refused(query, { from: '2026-11-13' })).code).toBe('validation_failed');
    expect(
      (
        await refused(query, {
          from: '2026-11-13T10:00:00Z',
          to: '2026-11-13T09:00:00Z',
        })
      ).code,
    ).toBe('validation_failed');
  });

  it('refuses a cursor it did not issue', async () => {
    const { query } = await seeded([event(1)]);
    expect((await refused(query, { cursor: 'not-a-cursor!' })).code).toBe('validation_failed');
    expect((await refused(query, { cursor: encodeCursor({ at: 1.5, id: 'x' }) })).code).toBe(
      'validation_failed',
    );
  });

  it('pages through every matching event once, in order, for any page size', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 40 }), { minLength: 0, maxLength: 120 }),
        fc.integer({ min: 1, max: 25 }),
        async (times, limit) => {
          // Several events may share one millisecond: the order then comes from the identifier.
          const events = times.map((t, i) => event(i + 1, { at: BASE + t }));
          const { query } = await seeded(events);
          const expected = events
            .map((e) => e.id)
            .sort((a, b) => {
              const ea = events.find((e) => e.id === a)!;
              const eb = events.find((e) => e.id === b)!;
              return ea.at - eb.at || (a < b ? -1 : a > b ? 1 : 0);
            });
          const seen: string[] = [];
          let cursor: string | undefined;
          for (let guard = 0; guard < 500; guard++) {
            const body = await page(query, { limit: String(limit), cursor });
            expect(body.items.length).toBeLessThanOrEqual(limit);
            seen.push(...body.items.map((i) => i.id));
            if (body.nextCursor === null) break;
            cursor = body.nextCursor;
          }
          expect(seen).toEqual(expected);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('pages across more than one store read (more than 1000 events)', async () => {
    const events = Array.from({ length: 2600 }, (_, i) =>
      event(i + 1, { at: BASE + Math.floor(i / 3) }),
    );
    const { query } = await seeded(events);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const body = await page(query, { limit: '200', cursor });
      seen.push(...body.items.map((i) => i.id));
      if (body.nextCursor === null) break;
      cursor = body.nextCursor;
    }
    expect(seen).toHaveLength(2600);
    expect(new Set(seen).size).toBe(2600);
  });

  it('refuses, rather than skipping, a page that would need more events than one store read in one millisecond', async () => {
    const events = Array.from({ length: 1100 }, (_, i) => event(i + 1, { at: BASE }));
    const { query } = await seeded(events);
    let cursor: string | undefined;
    let e: ApiError | undefined;
    for (let i = 0; i < 30; i++) {
      try {
        const body = await page(query, { limit: '200', cursor });
        if (body.nextCursor === null) break;
        cursor = body.nextCursor;
      } catch (err) {
        e = err as ApiError;
        break;
      }
    }
    expect(e?.code).toBe('unavailable');
  });
});

describe('UX-081 criterion 4: another tenant is never returned', () => {
  it('returns only the caller tenant events', async () => {
    const { query } = await seeded([
      event(1),
      event(2, { tenant: 'tenant-b' }),
      event(3, { tenant: 'tenant-b', actor: 'actor-1' }),
    ]);
    const body = await page(query, {});
    expect(body.items.map((i) => i.id)).toEqual(['ev-000001']);
    expect((await page(query, {}, service('tenant-b'))).items.map((i) => i.id)).toEqual([
      'ev-000002',
      'ev-000003',
    ]);
  });
});
