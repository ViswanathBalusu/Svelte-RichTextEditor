/**
 * The host's token endpoint (13 §11.1 item 1; 05 §3.1; UX-092): authenticates the person by the
 * host's own session, decides their role on the document from the host's catalogue, and returns a
 * token for that one document in the response body. 401 without a session, 403 without a role.
 */
import { error, json } from '@sveltejs/kit';
import { host } from '../../../../../lib/server/host.ts';
import { NO_STORE, requirePerson } from '../../../../../lib/server/request.ts';
import { ServiceError } from '../../../../../lib/server/service.ts';
import { tokenFor, type IssuedToken } from '../../../../../lib/server/tokens.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, cookies, request }) => {
  const h = await host();
  const person = requirePerson(h, cookies, params.user);
  const body = (await request.json().catch(() => null)) as { docId?: unknown } | null;
  const docId = typeof body?.docId === 'string' ? body.docId : '';
  let issued: IssuedToken | null;
  try {
    // The role, `access_since` and `restrict` come from the catalogue as it is now (`grantFor`).
    issued = await tokenFor(h, person, docId);
  } catch (e) {
    // The service's answer names a code, never the token (BE-088).
    if (e instanceof ServiceError) error(502, `The document service refused: ${e.code}.`);
    throw e;
  }
  if (!issued) error(403, 'You have no role on this document.');
  return json(issued, { headers: NO_STORE });
};
