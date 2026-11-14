/** Every page under `/as/<sub>/` acts as that person, if this browser chose them (UX-092). */
import { redirect } from '@sveltejs/kit';
import { host } from '../../../lib/server/host.ts';
import { personOf } from '../../../lib/server/request.ts';
import { userPath } from '../../../lib/server/sessions.ts';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ params, cookies, locals }) => {
  const h = await host();
  const person = personOf(h, cookies, params.user);
  if (!person) redirect(303, '/');
  locals.sub = person.sub;
  return { person: { sub: person.sub, name: person.name }, base: userPath(person.sub) };
};
