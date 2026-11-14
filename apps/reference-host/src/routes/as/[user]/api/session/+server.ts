/** Whether this person's demo session is still valid: 204, or 401 (the page glue asks on `de-auth-required`). */
import { host } from '../../../../../lib/server/host.ts';
import { NO_STORE, requirePerson } from '../../../../../lib/server/request.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, cookies }) => {
  requirePerson(await host(), cookies, params.user);
  return new Response(null, { status: 204, headers: NO_STORE });
};
