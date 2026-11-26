/**
 * The page behind the link in an invitation (UX-099). The link names an invitation and carries no
 * token. The person asks for a one-time passcode, which the host mails to the address it holds,
 * and enters it; the host then mints the participant's token (send-for-completion.ts). The token
 * is not put on this page: the participant's editing view is not built yet (UX-099 Notes).
 */
import { fail } from '@sveltejs/kit';
import {
  SIGNATURE_STATEMENT,
  startPasscode,
  verifyPasscode,
} from '../../../lib/server/send-for-completion.ts';
import { workflowDeps } from '../../../lib/server/workflow-runtime.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, setHeaders }) => {
  // The reference is a bearer reference to an invitation: keep it out of caches and referrers.
  setHeaders({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  const d = await workflowDeps();
  const found = d.store.byInvitation(params.invitation);
  return {
    known: found !== null,
    name: found?.participant.name ?? null,
    title: found ? (d.host.catalogue.get(found.record.doc)?.title ?? 'a document') : null,
    statement: SIGNATURE_STATEMENT,
  };
};

export const actions: Actions = {
  ask: async ({ params }) => {
    const d = await workflowDeps();
    const asked = await startPasscode(d, params.invitation);
    if (asked === null) return fail(404, { problem: 'This link is no longer valid.' });
    return { asked: true };
  },

  verify: async ({ params, request }) => {
    const d = await workflowDeps();
    const code = String((await request.formData()).get('passcode') ?? '');
    const result = await verifyPasscode(d, params.invitation, code);
    if (result.ok) return { verified: true };
    const messages: Record<string, string> = {
      unknown: 'This link is no longer valid.',
      none: 'Ask for a passcode first.',
      expired: 'The passcode has lapsed. Ask for a new one.',
      wrong: 'That passcode is not right. Check it and try again.',
      locked: 'Too many wrong tries. Ask for a new passcode.',
    };
    return fail(400, {
      problem: messages[result.reason] ?? 'The passcode was not accepted.',
      asked: true,
    });
  },
};
