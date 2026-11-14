/** Ends this person's demo session and goes back to the start page. */
import { redirect } from '@sveltejs/kit';
import { host } from '../../../../lib/server/host.ts';
import { SESSION_COOKIE, userPath } from '../../../../lib/server/sessions.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, cookies }) => {
  const h = await host();
  h.sessions.end(cookies.get(SESSION_COOKIE));
  cookies.delete(SESSION_COOKIE, { path: userPath(params.user) });
  redirect(303, '/');
};
