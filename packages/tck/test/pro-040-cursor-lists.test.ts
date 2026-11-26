// Cursor lists in the kit (PRO-040 criterion 5): the reader that follows `nextCursor` to the end
// and the rule that it sees every item once, against lists served from memory. A list that pages
// correctly passes at every page size; one that repeats an item, loses an item, offers a cursor
// twice, overfills a page or never ends fails. The scenario `core.rest.cursors` runs the same
// reader against real servers (mock.test.ts, reference.test.ts).
import { DEP1 } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import {
  everyItemOnce,
  listRoutes,
  missingFrom,
  readList,
  seenTwice,
  type GetPage,
} from '../src/lists.ts';
import { PROFILES } from '../src/profiles/index.ts';
import type { HttpResponse } from '../src/rest.ts';

const answer = (status: number, json: unknown): HttpResponse => ({
  method: 'GET',
  url: 'http://kit.test/list',
  status,
  headers: new Headers(),
  text: JSON.stringify(json),
  json,
});

/** A list of `n` items served in pages; `page` may spoil what a correct server would answer. */
function served(
  n: number,
  spoil: (items: unknown[], next: string | null, offset: number, limit: number) => unknown = (
    items,
    nextCursor,
  ) => ({ items, nextCursor }),
): { get: GetPage; calls: Array<Record<string, string | number>> } {
  const all = Array.from({ length: n }, (_, i) => ({ id: `item-${i}` }));
  const calls: Array<Record<string, string | number>> = [];
  const get: GetPage = async (query) => {
    calls.push(query);
    const limit = Number(query['limit']);
    const offset = query['cursor'] === undefined ? 0 : Number(String(query['cursor']).slice(2));
    const next = offset + limit < n ? `o:${offset + limit}` : null;
    return answer(200, spoil(all.slice(offset, offset + limit), next, offset, limit));
  };
  return { get, calls };
}

describe('reading a cursor list to its end (PRO-040 criterion 5)', () => {
  it('follows nextCursor until it is null and sees every item once, at every page size', async () => {
    for (const [n, limit, pages] of [
      [0, 1, 1],
      [1, 1, 1],
      [5, 1, 5],
      [5, 2, 3],
      [250, 200, 2],
    ] as const) {
      const s = served(n);
      const items = await readList(s.get, limit, 'GET /list');
      expect(items?.map((x) => (x as { id: string }).id)).toEqual(
        Array.from({ length: n }, (_, i) => `item-${i}`),
      );
      expect(s.calls).toHaveLength(pages);
      expect(s.calls[0]).toEqual({ limit });
      expect(seenTwice(items!)).toEqual([]);
    }
  });

  it('walks a list in pages of 200 and in small pages, and passes a list that pages correctly', async () => {
    expect((await everyItemOnce(served(7).get, 'GET /list'))?.limit).toBe(1);
    const long = await everyItemOnce(served(250).get, 'GET /list');
    expect([long?.items.length, long?.limit]).toEqual([250, 9]);
  });

  it('reports a route the server does not offer instead of failing', async () => {
    for (const status of [404, 405, 501])
      expect(
        await everyItemOnce(async () => answer(status, { code: 'not_found' }), 'x'),
      ).toBeNull();
  });

  it('fails a list that shows an item twice across pages', async () => {
    // Every page after the first starts one item early.
    const s = served(5, (items, next, offset, limit) => ({
      items: offset > 0 ? [{ id: `item-${offset - 1}` }, ...items.slice(0, limit - 1)] : items,
      nextCursor: next,
    }));
    await expect(everyItemOnce(s.get, 'GET /list')).rejects.toThrow(/no item is seen twice/);
  });

  it('fails a list that loses an item between pages', async () => {
    // In pages of one, the third item is skipped; pages of 200 show it.
    const s = served(5, (items, next, offset, limit) => ({
      items: limit === 1 && offset === 2 ? [] : items,
      nextCursor: next,
    }));
    await expect(everyItemOnce(s.get, 'GET /list')).rejects.toThrow(/show every item/);
  });

  it('fails a page with more items than limit, a body that is not a cursor list, and a bad cursor', async () => {
    const tooMany = served(5, (_i, next) => ({
      items: [{ id: 'a' }, { id: 'b' }],
      nextCursor: next,
    }));
    await expect(readList(tooMany.get, 1, 'GET /list')).rejects.toThrow(/respects limit/);
    const bare = served(5, (items) => items);
    await expect(readList(bare.get, 1, 'GET /list')).rejects.toThrow(/a cursor list/);
    const noCursor = served(5, (items) => ({ items }));
    await expect(readList(noCursor.get, 1, 'GET /list')).rejects.toThrow(/a cursor list/);
    const numeric = served(5, (items) => ({ items, nextCursor: 7 }));
    await expect(readList(numeric.get, 1, 'GET /list')).rejects.toThrow(/string or null/);
  });

  it('fails a list that offers the same cursor again, and one that never ends', async () => {
    const loop = served(5, (items) => ({ items, nextCursor: 'o:0' }));
    await expect(readList(loop.get, 1, 'GET /list')).rejects.toThrow(/not offered twice/);
    let i = 0;
    const endless: GetPage = async () => answer(200, { items: [{ id: i }], nextCursor: `c${i++}` });
    await expect(readList(endless, 1, 'GET /list', 25)).rejects.toThrow(/did not end/);
  });

  it('fails a later page that is not served', async () => {
    const s = served(3);
    const get: GetPage = async (q) =>
      q['cursor'] === undefined ? s.get(q) : answer(500, { code: 'internal' });
    await expect(readList(get, 1, 'GET /list')).rejects.toThrow(/page 2 was not served/);
  });

  it('names the items a smaller walk misses', () => {
    expect(missingFrom([{ id: 1 }], [{ id: 1 }, { id: 2 }])).toEqual(['{"id":2}']);
  });
});

describe('the list routes the kit walks (PRO-040 criterion 5)', () => {
  it('are every GET of the protocol definition that answers with a list, except the operator routes', () => {
    const fromDefinition = DEP1.operations
      .filter(
        (o) =>
          o.method === 'GET' &&
          o.success.list === true &&
          !(o.security.length > 0 && o.security.every((c) => c === 'operator')),
      )
      .map((o) => o.path);
    expect(listRoutes().map((r) => r.path)).toEqual(fromDefinition);
    expect(fromDefinition).toEqual(
      expect.arrayContaining(['/documents', '/documents/{id}/commits', '/documents/{id}/regions']),
    );
    // The only required query parameter is the commit list's `after`, which the scenario supplies.
    expect(listRoutes().flatMap((r) => r.required.map((q) => `${r.operationId}.${q}`))).toEqual([
      'listCommits.after',
    ]);
  });

  it('are walked by a scenario of the core profile', () => {
    const core = PROFILES.find((p) => p.id === 'core');
    expect(core?.scenarios.map((s) => s.id)).toContain('core.rest.cursors');
  });
});
