/**
 * Cursor lists (05 §6.1; D14, D72; PRO-040): reading a list route to its end by following
 * `nextCursor`, and the rule that a reader who does so sees every item once. The reader takes the
 * request as a function, so that it serves every list route and can be tested without a server.
 */
import { DEP1 } from '@docedit/protocol';
import { KitFailure, check, isObject } from './assert.ts';
import type { HttpResponse } from './rest.ts';

/** One list route of the protocol definition: a `GET` whose answer is `{ items, nextCursor }`. */
export interface ListRoute {
  readonly operationId: string;
  /** The path of 05 §6.2, for example `/documents/{id}/commits`. */
  readonly path: string;
  /** The query parameters the route requires. */
  readonly required: readonly string[];
}

/**
 * Every list route the protocol definition has, in its order, that a service credential or a user
 * token may read. A route for the operator credential alone (`GET /tenants`, decision 68) is left
 * out: the kit holds no operator credential, and row 14 of the matrix has its own scenario.
 */
export function listRoutes(): ListRoute[] {
  return DEP1.operations
    .filter(
      (o) =>
        o.method === 'GET' &&
        o.success.list === true &&
        !(o.security.length > 0 && o.security.every((c) => c === 'operator')),
    )
    .map((o) => ({
      operationId: o.operationId,
      path: o.path,
      required: Object.entries(o.query ?? {})
        .filter(([, q]) => q.required)
        .map(([name]) => name),
    }));
}

/** A page request: the query carries `limit` and, after the first page, `cursor`. */
export type GetPage = (query: Record<string, string | number>) => Promise<HttpResponse>;

/** The statuses that say the server does not offer the route at all. */
const NOT_OFFERED = new Set([404, 405, 501]);

/**
 * Reads a list to its end with pages of at most `limit` items. Resolves the items in the order
 * they came, or null when the first answer says the route is not offered. Fails when a page is not
 * `{ items, nextCursor }`, holds more than `limit` items, or names a cursor that was given before.
 */
export async function readList(
  get: GetPage,
  limit: number,
  what: string,
  maxPages = 20_000,
): Promise<unknown[] | null> {
  const items: unknown[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const res = await get({ limit, ...(cursor === null ? {} : { cursor }) });
    if (page === 0 && NOT_OFFERED.has(res.status)) return null;
    if (res.status !== 200)
      throw new KitFailure(
        `${what}: page ${page + 1} was not served`,
        200,
        `${res.status} ${res.text.slice(0, 200)}`,
      );
    const j = res.json;
    if (!isObject(j) || !Array.isArray(j['items']) || !('nextCursor' in j))
      throw new KitFailure(`${what}: a cursor list (05 §6.1)`, '{ items, nextCursor }', j);
    const got = j['items'] as unknown[];
    check(got.length <= limit, `${what}: a page respects limit`, `≤ ${limit} items`, got.length);
    items.push(...got);
    const next: unknown = j['nextCursor'];
    if (next === null) return items;
    if (typeof next !== 'string' || next === '')
      throw new KitFailure(
        `${what}: nextCursor is a string or null (D14)`,
        'a non-empty string or null',
        next,
      );
    check(!cursors.has(next), `${what}: a cursor is not offered twice`, 'a new cursor', next);
    cursors.add(next);
    cursor = next;
  }
  throw new KitFailure(`${what}: the list did not end`, `an end within ${maxPages} pages`, 'none');
}

/** The items a walk saw more than once, as JSON texts. */
export function seenTwice(items: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const it of items) {
    const key = JSON.stringify(it);
    if (seen.has(key)) twice.add(key);
    seen.add(key);
  }
  return [...twice];
}

/** The items of `whole` that `paged` does not hold, as JSON texts. */
export function missingFrom(paged: readonly unknown[], whole: readonly unknown[]): string[] {
  const have = new Set(paged.map((it) => JSON.stringify(it)));
  return whole.map((it) => JSON.stringify(it)).filter((key) => !have.has(key));
}

/**
 * Walks one list twice, in pages of 200 and then in small pages, and checks that the small pages
 * show every item once: none twice, and none of the first walk missing. Resolves the number of
 * items and the small page size, or null when the route is not offered.
 */
export async function everyItemOnce(
  get: GetPage,
  what: string,
): Promise<{ items: unknown[]; limit: number } | null> {
  const whole = await readList(get, 200, what);
  if (whole === null) return null;
  // Pages of one item, or about thirty pages for a long list.
  const limit = whole.length > 60 ? Math.ceil(whole.length / 30) : 1;
  const paged = await readList(get, limit, what);
  if (paged === null)
    throw new KitFailure(`${what}: the route answered and then did not`, 'a list', 'not offered');
  for (const [name, walk] of [
    ['pages of 200', whole],
    [`pages of ${limit}`, paged],
  ] as const) {
    const twice = seenTwice(walk);
    check(
      twice.length === 0,
      `${what}: no item is seen twice in ${name} (05 §6.1)`,
      'every item once',
      twice.slice(0, 3),
    );
  }
  const missing = missingFrom(paged, whole);
  check(
    missing.length === 0,
    `${what}: pages of ${limit} show every item that pages of 200 show (05 §6.1)`,
    'every item once',
    missing.slice(0, 3),
  );
  return { items: paged, limit };
}
