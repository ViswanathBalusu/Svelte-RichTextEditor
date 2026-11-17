// UX-084 (lane w3): `GET /v1/search` for a host's catalogue, over HTTP and in memory. A service
// credential gets the hits of its own tenant with `externalId`, ranked by score and then by
// identifier, paged with an opaque cursor; a user token is refused. The index is the in-memory
// `SearchIndex` that the PostgreSQL index matches (be-054-search-index.pg.test.ts). Criteria 3 (the
// freshness bound) and 4 (the purge) need the checkpoint hook and the purge pipeline of BE-054 and
// HIS-038, which are not built, so they are not tested here.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SearchIndex } from '../../src/control-plane/search-index.ts';
import { startHarness, type Harness } from './support.ts';

const para = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

describe('UX-084 GET /v1/search', () => {
  const index = new SearchIndex();
  let h: Harness;
  let a: string;
  let b: string;
  let c: string;
  let gone: string;

  const index_ = (doc: string, text: string, tenant = h.tenant, seq = 1) =>
    index.indexCheckpoint({ tenant, doc, seq, visibility: 'full', content: para(text) });

  beforeAll(async () => {
    h = await startHarness('memory', { parts: { search: index } });
    a = await h.createDocument({ externalId: 'cat-a' });
    b = await h.createDocument({ externalId: 'cat-b' });
    c = await h.createDocument({}); // No external identifier.
    gone = await h.createDocument({ externalId: 'cat-gone' });
    index_(a, 'invoice invoice invoice');
    index_(b, 'invoice invoice');
    index_(c, 'the invoice');
    index_(gone, 'invoice invoice invoice invoice');
    // Another tenant: the same word, never returned to this tenant.
    index_('doc-of-another-tenant', 'invoice invoice invoice invoice invoice', 'another-tenant');
    const del = await h.call('DELETE', `/v1/documents/${gone}`, { token: h.apiKey });
    expect(del.status, del.text).toBeLessThan(300);
  }, 60_000);
  afterAll(() => h?.close());

  const get = (query: string, token = h.apiKey) => h.call('GET', `/v1/search${query}`, { token });

  it('returns identifiers and externalId, best first, with no cursor on the last page (criterion 1)', async () => {
    const r = await get('?q=invoice&limit=10');
    expect(r.status, r.text).toBe(200);
    expect(r.json.nextCursor).toBeNull();
    expect(r.json.items).toEqual([
      { doc: a, externalId: 'cat-a', seq: 1, score: 3 },
      { doc: b, externalId: 'cat-b', seq: 1, score: 2 },
      { doc: c, externalId: null, seq: 1, score: 1 },
    ]);
  });

  it('pages with a cursor that continues after the last hit, without gaps or repeats (criterion 1)', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r: Awaited<ReturnType<typeof get>> = await get(
        `?q=invoice&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      expect(r.status, r.text).toBe(200);
      expect(r.json.items.length).toBeLessThanOrEqual(1);
      for (const i of r.json.items as { doc: string }[]) seen.push(i.doc);
      cursor = r.json.nextCursor as string | null;
      pages++;
    } while (cursor !== null && pages < 10);
    expect(seen).toEqual([a, b, c]);
    expect(pages).toBe(3);
  });

  it('breaks a tie in score by document identifier, on every page', async () => {
    const t1 = await h.createDocument({});
    const t2 = await h.createDocument({});
    index_(t1, 'tiebreak');
    index_(t2, 'tiebreak');
    const first = await get('?q=tiebreak&limit=1');
    const second = await get(
      `?q=tiebreak&limit=1&cursor=${encodeURIComponent(first.json.nextCursor)}`,
    );
    const [lo, hi] = [t1, t2].sort();
    expect(first.json.items[0].doc).toBe(lo);
    expect(second.json.items[0].doc).toBe(hi);
    expect(second.json.nextCursor).toBeNull();
  });

  it('never returns a document of another tenant, nor a deleted document (criterion 2)', async () => {
    const r = await get('?q=invoice&limit=50');
    const docs = (r.json.items as { doc: string }[]).map((i) => i.doc);
    expect(docs).not.toContain('doc-of-another-tenant');
    expect(docs).not.toContain(gone);
    expect(r.text).not.toContain('another-tenant');
  });

  it('refuses a user token with forbidden (criterion 5)', async () => {
    const user = h.userToken({ [a]: 'editor' });
    const r = await get('?q=invoice&limit=10', user);
    expect(r.status).toBe(403);
    expect(r.json.code ?? r.json.type).toMatch(/forbidden/);
  });

  it('refuses a cursor that an earlier page did not give, and a missing q or limit', async () => {
    for (const q of [
      '?q=invoice&limit=1&cursor=not-a-cursor',
      '?q=invoice&limit=1&cursor=e30',
      '?limit=1',
      '?q=invoice',
    ]) {
      const r = await get(q);
      expect(r.status, q).toBe(400);
    }
  });
});
