/**
 * The host's directory for the page glue (05 §8.1 `resolveUsers`, `searchPrincipals`; UX-093
 * criterion 1): names for identifiers, and people and groups for a search string.
 */
import { error, json } from '@sveltejs/kit';
import { host } from '../../../../../lib/server/host.ts';
import { NO_STORE, requirePerson } from '../../../../../lib/server/request.ts';
import type { RequestHandler } from './$types';

/** At most this many identifiers or results per call: a setting (ADR 0048). */
const MAX = 100;

export const POST: RequestHandler = async ({ params, cookies, request }) => {
  const h = await host();
  requirePerson(h, cookies, params.user);
  const body = (await request.json().catch(() => null)) as {
    resolve?: unknown;
    search?: { text?: unknown; kinds?: unknown; limit?: unknown };
  } | null;
  if (Array.isArray(body?.resolve)) {
    const ids = body.resolve.filter((x): x is string => typeof x === 'string').slice(0, MAX);
    return json({ users: h.directory.resolve(ids) }, { headers: NO_STORE });
  }
  if (body?.search && typeof body.search.text === 'string') {
    const kinds = (Array.isArray(body.search.kinds) ? body.search.kinds : ['user', 'group']).filter(
      (k): k is 'user' | 'group' => k === 'user' || k === 'group',
    );
    const limit = typeof body.search.limit === 'number' ? Math.min(body.search.limit, MAX) : 10;
    return json(
      { principals: h.directory.search(body.search.text, kinds, limit) },
      { headers: NO_STORE },
    );
  }
  error(400, 'Send { resolve: [ids] } or { search: { text } }.');
};
