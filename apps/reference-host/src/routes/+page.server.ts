/**
 * The demo sign-in (UX-092 criterion 1): the seeded people, and a form per person. Choosing one
 * starts a session for that person whose cookie only the paths under `/as/<sub>/` receive, so two
 * tabs of one browser can act as two people.
 */
import { fail, redirect } from '@sveltejs/kit';
import { host } from '../lib/server/host.ts';
import { SESSION_COOKIE, userPath } from '../lib/server/sessions.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
  const h = await host();
  return {
    people: h.directory.users.map((u) => ({ sub: u.sub, name: u.name, about: u.about })),
    tokenMode: h.tokens.mode,
  };
};

export const actions: Actions = {
  signin: async ({ request, cookies, url }) => {
    const h = await host();
    const sub = String((await request.formData()).get('sub') ?? '');
    if (!h.directory.user(sub)) return fail(400, { problem: 'Choose one of the people listed.' });
    cookies.set(SESSION_COOKIE, h.sessions.create(sub), {
      path: userPath(sub),
      httpOnly: true,
      sameSite: 'strict',
      secure: url.protocol === 'https:',
    });
    // The canonical path has no trailing slash: a 308 from `/as/<sub>/` after this 303 makes
    // WebKit replay the sign-in POST to `/as/<sub>` (a 404), so the redirect must not go through one.
    redirect(303, userPath(sub));
  },
};
