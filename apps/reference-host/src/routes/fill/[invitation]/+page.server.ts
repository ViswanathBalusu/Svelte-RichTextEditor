/**
 * The page behind the link in an invitation (UX-099, UX-106). The link names an invitation and
 * carries no token. The person asks for a one-time passcode, which the host mails to the address it
 * holds, and enters it. A right one starts the participant's session: a cookie that the page's
 * scripts cannot read (participant-session.ts). The page then mounts the editor in fill mode. The
 * token is never put on the page: the editor asks the host's token endpoint for it (api/token),
 * which checks the session.
 */
import { fail } from '@sveltejs/kit';
import { host } from '../../../lib/server/host.ts';
import { PARTICIPANT_COOKIE } from '../../../lib/server/participant-session.ts';
import {
  SIGNATURE_STATEMENT,
  startPasscode,
  verifyPasscode,
} from '../../../lib/server/send-for-completion.ts';
import { participantSessions, workflowDeps } from '../../../lib/server/workflow-runtime.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, setHeaders, cookies }) => {
  // The reference is a bearer reference to an invitation: keep it out of caches and, with
  // `same-origin`, out of the referrer of other sites. Not `no-referrer`: a browser then sends
  // `Origin: null` with the page's own forms and SvelteKit refuses them (hooks.server.ts).
  setHeaders({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin' });
  const d = await workflowDeps();
  const h = await host();
  const found = d.store.byInvitation(params.invitation);
  const session = participantSessions.check(cookies.get(PARTICIPANT_COOKIE), params.invitation);
  const mine = found !== null && session !== null && session.participant === found.participant.id;
  const finished = found?.participant.finished ?? null;
  return {
    known: found !== null,
    name: found?.participant.name ?? null,
    title: found ? (d.host.catalogue.get(found.record.doc)?.title ?? 'a document') : null,
    statement: SIGNATURE_STATEMENT,
    // The editor is mounted for a participant who passed the passcode and whose part is not over.
    // The document's identifier is not a secret: the participant's token names it too.
    doc: mine && finished === null ? found.record.doc : null,
    finished,
    endpoint: h.config.endpoint,
    viewerUrl: h.config.viewerUrl ?? null,
    api: `/fill/${encodeURIComponent(params.invitation)}/api`,
  };
};

export const actions: Actions = {
  ask: async ({ params }) => {
    const d = await workflowDeps();
    const asked = await startPasscode(d, params.invitation);
    if (asked === null) return fail(404, { problem: 'This link is no longer valid.' });
    return { asked: true };
  },

  verify: async ({ params, request, cookies, url }) => {
    const d = await workflowDeps();
    const code = String((await request.formData()).get('passcode') ?? '');
    const result = await verifyPasscode(d, params.invitation, code);
    if (result.ok) {
      // The token that was minted for the passcode is not kept: the editor asks for its own through
      // the session, again when it runs out.
      cookies.set(
        PARTICIPANT_COOKIE,
        participantSessions.start(params.invitation, result.participant),
        {
          path: `/fill/${encodeURIComponent(params.invitation)}`,
          httpOnly: true,
          sameSite: 'strict',
          secure: url.protocol === 'https:',
        },
      );
      return { verified: true };
    }
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
