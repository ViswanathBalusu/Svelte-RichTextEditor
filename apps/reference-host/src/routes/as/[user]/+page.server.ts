/**
 * The host's document list (UX-094): the documents this person has a role on, from the host's own
 * catalogue, with the titles the host stores. New, rename and delete go through the host's server,
 * which calls the document service with its service credential; the editor never lists documents.
 */
import { fail, redirect } from '@sveltejs/kit';
import {
  cleanTitle,
  createFromTemplate,
  deleteDocument,
  renameDocument,
} from '../../../lib/server/documents.ts';
import { host } from '../../../lib/server/host.ts';
import { requirePerson } from '../../../lib/server/request.ts';
import { ServiceError } from '../../../lib/server/service.ts';
import { userPath } from '../../../lib/server/sessions.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
  const { person } = await parent();
  const h = await host();
  return {
    documents: h.catalogue.listFor(person.sub).map((d) => ({
      id: d.id,
      externalId: d.externalId,
      title: d.title,
      role: d.roles[person.sub]!,
      createdAt: d.createdAt,
    })),
    templates: h.seed.templates.map((t) => ({ key: t.key, title: t.title })),
  };
};

function problem(e: unknown): string {
  if (e instanceof RangeError) return e.message;
  if (e instanceof ServiceError) return `The document service refused: ${e.code}.`;
  throw e;
}

export const actions: Actions = {
  create: async ({ request, cookies, params }) => {
    const h = await host();
    const person = requirePerson(h, cookies, params.user);
    const form = await request.formData();
    const template = h.seed.templates.find((t) => t.key === form.get('template'));
    if (!template) return fail(400, { problem: 'Choose a template.' });
    let id: string;
    try {
      const entry = await createFromTemplate(h, {
        template,
        title: cleanTitle(form.get('title')),
        creator: person.sub,
      });
      id = entry.id;
    } catch (e) {
      return fail(400, { problem: problem(e) });
    }
    // The new document opens in the editor (UX-094 criterion 2).
    redirect(303, `${userPath(person.sub)}/docs/${id}`);
  },

  rename: async ({ request, cookies, params }) => {
    const h = await host();
    const person = requirePerson(h, cookies, params.user);
    const form = await request.formData();
    const id = String(form.get('id') ?? '');
    if (h.catalogue.roleOf(id, person.sub) !== 'owner')
      return fail(403, { problem: 'Only the owner can rename this document.' });
    try {
      await renameDocument(h, id, String(form.get('title') ?? ''), person.sub);
    } catch (e) {
      return fail(400, { problem: problem(e) });
    }
    return { done: 'Renamed.' };
  },

  delete: async ({ request, cookies, params }) => {
    const h = await host();
    const person = requirePerson(h, cookies, params.user);
    const id = String((await request.formData()).get('id') ?? '');
    if (h.catalogue.roleOf(id, person.sub) !== 'owner')
      return fail(403, { problem: 'Only the owner can delete this document.' });
    try {
      await deleteDocument(h, id, person.sub);
    } catch (e) {
      return fail(400, { problem: problem(e) });
    }
    return { done: 'Deleted.' };
  },
};
