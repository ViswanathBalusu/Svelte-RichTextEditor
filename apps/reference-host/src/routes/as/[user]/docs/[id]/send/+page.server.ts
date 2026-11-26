/**
 * The owner's page for sending a document for completion (UX-099): name a person for each role
 * placeholder, send, and see who has been invited and what has come back. The mail itself is sent
 * when the service says a participant is activated (send-for-completion.ts, the webhook route).
 */
import { error, fail } from '@sveltejs/kit';
import { host } from '../../../../../../lib/server/host.ts';
import { requirePerson } from '../../../../../../lib/server/request.ts';
import {
  PARTICIPANT_KINDS,
  SIGNATURE_STATEMENT,
  SendRefused,
  rolesOf,
  sendForCompletion,
  type ParticipantKind,
} from '../../../../../../lib/server/send-for-completion.ts';
import { ServiceError } from '../../../../../../lib/server/service.ts';
import { workflowDeps } from '../../../../../../lib/server/workflow-runtime.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, parent }) => {
  const { person } = await parent();
  const h = await host();
  const entry = h.catalogue.get(params.id);
  if (entry?.roles[person.sub] !== 'owner') error(404, 'Only the owner of a document can send it.');
  const d = await workflowDeps();
  const record = d.store.get(entry.id);
  return {
    doc: { id: entry.id, title: entry.title },
    roles: record ? [] : await rolesOf(h, entry.id),
    kinds: PARTICIPANT_KINDS,
    statement: SIGNATURE_STATEMENT,
    mailConfigured: Boolean(process.env['DOCEDIT_HOST_SMTP']),
    sent: record
      ? {
          state: record.state,
          sentAt: record.sentAt,
          // Names, roles and order only; the addresses stay on the server.
          participants: record.participants.map((p) => ({
            id: p.id,
            name: p.name,
            roles: p.roles,
            kind: p.kind,
            order: p.order,
          })),
          results: record.results !== undefined,
        }
      : null,
  };
};

export const actions: Actions = {
  send: async ({ request, cookies, params }) => {
    const h = await host();
    const person = requirePerson(h, cookies, params.user);
    const form = await request.formData();
    const roles = form.getAll('role').map(String);
    const people = roles.map((role, i) => ({
      role,
      name: String(form.getAll('name')[i] ?? ''),
      email: String(form.getAll('email')[i] ?? ''),
      kind: String(form.getAll('kind')[i] ?? 'filler') as ParticipantKind,
      order: Number(form.getAll('order')[i] ?? i + 1),
    }));
    const d = await workflowDeps();
    try {
      await sendForCompletion(d.host, d.store, {
        doc: params.id,
        owner: person.sub,
        participants: people.map((p) => ({ ...p, order: Number.isInteger(p.order) ? p.order : 1 })),
      });
    } catch (e) {
      if (e instanceof SendRefused) return fail(400, { problem: e.message });
      if (e instanceof ServiceError)
        return fail(400, { problem: `The document service refused: ${e.code}.` });
      throw e;
    }
    return { done: 'Sent. Each person is invited by e-mail when their turn comes.' };
  },
};
