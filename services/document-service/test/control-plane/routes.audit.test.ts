// GET /audit over real HTTP, through the request pipeline and the router, against an in-process
// service with in-memory storage (UX-081 criteria 2, 3, 4 and 6; 05 section 6.2; 13 section 10).
// The events are written to the service's own audit store (`parts.audit`), the store the route
// reads. Test values only. PostgreSQL is not run here: the route is the same, and PgAuditStore's
// query is covered by the data plane's PostgreSQL tests.
import { randomUUID } from 'node:crypto';
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashSecret } from '../../src/control-plane/tenants.ts';
import { newApiKey } from '../../src/control-plane/tokens.ts';
import type { AuditEvent } from '../../src/storage/types.ts';
import { startHarness, type CallResult, type Harness } from './support.ts';

/** Strings that must never leave the service in an audit page (criterion 6). */
const CONTENT = 'Liability is capped at the fee paid';
const TOKEN = 'eyJhbGciOiJFZERTQSJ9.secret-token-value.signature';

interface Item {
  id: string;
  document: string | null;
  actor: string;
  kind: string;
  scopes: string[];
  at: string;
}

describe('GET /audit over HTTP (UX-081)', () => {
  let h: Harness;
  let other: { tenant: string; apiKey: string };
  const docA = randomUUID();
  const docB = randomUUID();
  const base = Date.parse('2026-11-13T09:00:00.000Z');
  const mine: AuditEvent[] = [];
  const theirs: AuditEvent[] = [];

  const event = (tenant: string, n: number, over: Partial<AuditEvent> = {}): AuditEvent => ({
    id: uuid7(),
    tenant,
    doc: docA,
    actor: 'actor-1',
    kind: 'commit.rejected',
    data: { scopes: ['text.write'], text: CONTENT, token: TOKEN },
    at: base + n * 1000,
    ...over,
  });

  beforeAll(async () => {
    h = await startHarness('memory');
    // A second tenant with its own API key.
    const tenant = randomUUID();
    await h.parts.registry.putTenant(tenant, 'Other tenant');
    const key = newApiKey(tenant);
    await h.parts.registry.addApiKey(tenant, { id: key.id, secretHash: hashSecret(key.secret) });
    other = { tenant, apiKey: key.credential };

    mine.push(
      event(h.tenant, 1),
      event(h.tenant, 2, { kind: 'grants.changed', data: { scopes: [] } }),
      event(h.tenant, 3, { actor: 'actor-2' }),
      event(h.tenant, 4, { doc: docB }),
      event(h.tenant, 5, { kind: 'incarnation.changed', doc: docB, actor: 'actor-2' }),
      event(h.tenant, 6, { doc: null, actor: 'system' }),
      event(h.tenant, 7),
    );
    // The other tenant's events share the document identifier, actor and kinds on purpose.
    theirs.push(event(tenant, 1), event(tenant, 4, { doc: docB }), event(tenant, 8));
    await h.parts.audit!.record([...mine, ...theirs]);
  });
  afterAll(async () => {
    await h?.close();
  });

  const get = (query: string, token: string): Promise<CallResult> =>
    h.call('GET', `/v1/audit${query}`, { token });
  const ids = (r: CallResult): string[] => (r.json.items as Item[]).map((i) => i.id);

  /** Every page of a query, following `nextCursor`. */
  async function all(query: string, token: string): Promise<Item[]> {
    const out: Item[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 50; i++) {
      const sep = query === '' ? '?' : '&';
      const r = await get(
        cursor === null ? query : `${query}${sep}cursor=${encodeURIComponent(cursor)}`,
        token,
      );
      expect(r.status, r.text).toBe(200);
      out.push(...(r.json.items as Item[]));
      cursor = r.json.nextCursor as string | null;
      if (cursor === null) return out;
    }
    throw new Error('the pages did not end');
  }

  describe('criterion 3: only a service credential may call it', () => {
    it('refuses a user token with forbidden, before anything is read', async () => {
      const user = h.userToken({ [docA]: 'owner' });
      const r = await get('', user);
      expect(r.status).toBe(403);
      expect(r.json.code).toBe('forbidden');
      expect(r.text).not.toContain(mine[0]!.id);
      // A user token that claims to be a service is still a user token.
      const posing = h.userToken({ [docA]: 'owner' }, { svc: true, typ_claim: 'service' });
      const p = await get('?limit=5', posing);
      expect(p.status).toBe(403);
      expect(p.json.code).toBe('forbidden');
    });

    it('answers an API key and a service JWT with a page', async () => {
      for (const token of [h.apiKey, h.serviceJwt()]) {
        const r = await get('', token);
        expect(r.status, r.text).toBe(200);
        expect(r.headers.get('cache-control')).toBe('no-store');
        expect(ids(r)).toEqual(mine.map((e) => e.id));
        expect(r.json.nextCursor).toBeNull();
      }
    });
  });

  describe('criterion 2: filters and cursor paging', () => {
    it('filters by document, actor, event kind and a time range', async () => {
      const ofDoc = await get(`?document=${docB}`, h.apiKey);
      expect(ids(ofDoc)).toEqual([mine[3]!.id, mine[4]!.id]);
      const ofActor = await get('?actor=actor-2', h.apiKey);
      expect(ids(ofActor)).toEqual([mine[2]!.id, mine[4]!.id]);
      const ofKind = await get('?kind=grants.changed', h.apiKey);
      expect(ids(ofKind)).toEqual([mine[1]!.id]);
      // `from` inclusive, `to` exclusive.
      const from = new Date(base + 3000).toISOString();
      const to = new Date(base + 6000).toISOString();
      const inRange = await get(`?from=${from}&to=${to}`, h.apiKey);
      expect(ids(inRange)).toEqual([mine[2]!.id, mine[3]!.id, mine[4]!.id]);
      const combined = await get(
        `?document=${docB}&actor=actor-2&kind=incarnation.changed`,
        h.apiKey,
      );
      expect(ids(combined)).toEqual([mine[4]!.id]);
    });

    it('pages with a cursor: every matching event once, in order, for each page size', async () => {
      for (const limit of [1, 2, 3, 7, 200]) {
        const items = await all(`?limit=${limit}`, h.apiKey);
        expect(items.map((i) => i.id)).toEqual(mine.map((e) => e.id));
      }
      // A filter and a cursor together.
      const items = await all('?document=' + docA + '&limit=1', h.apiKey);
      expect(items.map((i) => i.id)).toEqual(mine.filter((e) => e.doc === docA).map((e) => e.id));
      const first = await get('?limit=3', h.apiKey);
      expect(ids(first)).toHaveLength(3);
      expect(typeof first.json.nextCursor).toBe('string');
    });

    it('refuses a limit above 200, an unknown or repeated parameter and a bad cursor', async () => {
      for (const query of [
        '?limit=201',
        '?limit=0',
        '?colour=red',
        `?document=${docA}&document=${docB}`,
        '?cursor=not-a-cursor',
        '?from=yesterday',
      ]) {
        const r = await get(query, h.apiKey);
        expect(r.status, query).toBe(400);
        expect(r.json.code, query).toBe('validation_failed');
      }
    });
  });

  describe('criterion 4: another tenant is never returned', () => {
    it('returns each tenant only its own events, whatever the filters', async () => {
      const a = await all('', h.apiKey);
      expect(a.map((i) => i.id)).toEqual(mine.map((e) => e.id));
      const b = await all('', other.apiKey);
      expect(b.map((i) => i.id)).toEqual(theirs.map((e) => e.id));
      // The same document identifier in both tenants: each sees its own events only.
      const shared = await get(`?document=${docA}`, other.apiKey);
      expect(ids(shared)).toEqual([theirs[0]!.id, theirs[2]!.id]);
      const theirIds = new Set(theirs.map((e) => e.id));
      for (const i of a) expect(theirIds.has(i.id)).toBe(false);
    });

    it("does not open another tenant's page with that tenant's cursor", async () => {
      const page = await get('?limit=1', other.apiKey);
      const cursor = page.json.nextCursor as string;
      expect(typeof cursor).toBe('string');
      const r = await get(`?cursor=${encodeURIComponent(cursor)}`, h.apiKey);
      expect(r.status).toBe(200);
      const theirIds = new Set(theirs.map((e) => e.id));
      for (const id of ids(r)) expect(theirIds.has(id)).toBe(false);
    });
  });

  describe('criterion 6: no document content and no token in a returned event', () => {
    it('returns the fixed fields only, with the scopes of the data and nothing else', async () => {
      const r = await get('', h.apiKey);
      expect(r.status).toBe(200);
      expect(r.text).not.toContain(CONTENT);
      expect(r.text).not.toContain(TOKEN);
      expect(r.text).not.toContain(h.apiKey);
      for (const item of r.json.items as Item[])
        expect(Object.keys(item).sort()).toEqual([
          'actor',
          'at',
          'document',
          'id',
          'kind',
          'scopes',
        ]);
      const first = (r.json.items as Item[])[0]!;
      expect(first).toEqual({
        id: mine[0]!.id,
        document: docA,
        actor: 'actor-1',
        kind: 'commit.rejected',
        scopes: ['text.write'],
        at: new Date(mine[0]!.at).toISOString(),
      });
    });
  });
});
