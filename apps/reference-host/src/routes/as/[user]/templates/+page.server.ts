/**
 * The template gallery (UX-100; 13 §11.2; 12 §9): the templates in the host's catalogue, each with
 * the fields the author may fill in at the start. Using one calls the document service's templates
 * resource through the host's server (`POST /documents` with `template`), which forks the template
 * at a pinned `seq`; the new document then appears in the document list. The kinds of field the
 * service sets itself (signature, initials, date signed, formula) are never offered.
 */
import { fail, redirect } from '@sveltejs/kit';
import {
  cleanTitle,
  createFromGalleryTemplate,
  prefillableFields,
  type PrefillField,
} from '../../../../lib/server/documents.ts';
import { host } from '../../../../lib/server/host.ts';
import { requirePerson } from '../../../../lib/server/request.ts';
import { ServiceError } from '../../../../lib/server/service.ts';
import { userPath } from '../../../../lib/server/sessions.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
  // The layout checks who the page acts as; the gallery waits for it.
  await parent();
  const h = await host();
  const templates = [];
  for (const t of h.catalogue.listTemplates()) {
    let fields: PrefillField[] = [];
    let unavailable = false;
    try {
      fields = await prefillableFields(h, t);
    } catch (e) {
      if (!(e instanceof ServiceError)) throw e;
      unavailable = true;
    }
    templates.push({
      id: t.id,
      key: t.key,
      name: t.name,
      description: t.description,
      fields,
      unavailable,
    });
  }
  return { templates };
};

/** The values of the form for the offered fields: empty inputs are left out, a checkbox is true or left out. */
function valuesOf(form: FormData, fields: readonly PrefillField[]): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const f of fields) {
    const raw = form.get(`value:${f.key}`);
    if (f.kind === 'checkbox') {
      if (raw !== null) values[f.key] = true;
      continue;
    }
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (text !== '') values[f.key] = text;
  }
  return values;
}

function problem(e: unknown): string {
  if (e instanceof RangeError) return e.message;
  if (e instanceof ServiceError)
    return e.code === 'field_invalid'
      ? 'A value does not fit its field. Nothing was created.'
      : `The document service refused: ${e.code}.`;
  throw e;
}

export const actions: Actions = {
  use: async ({ request, cookies, params }) => {
    const h = await host();
    const person = requirePerson(h, cookies, params.user);
    const form = await request.formData();
    const template = h.catalogue.template(String(form.get('template') ?? ''));
    if (!template) return fail(400, { problem: 'Choose a template from the gallery.' });
    let id: string;
    try {
      const fields = await prefillableFields(h, template);
      const entry = await createFromGalleryTemplate(h, {
        template,
        title: cleanTitle(form.get('title')),
        creator: person.sub,
        values: valuesOf(form, fields),
      });
      id = entry.id;
    } catch (e) {
      return fail(400, { problem: problem(e), template: template.id });
    }
    // The new document is in the list, and opens in the editor.
    redirect(303, `${userPath(person.sub)}/docs/${id}`);
  },
};
