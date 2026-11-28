/**
 * The host's token endpoint for a participant (13 §11.1 item 1; 05 §3.1; UX-106). A participant has
 * no sign-in of the host's own: the session that the passcode started (a cookie scoped to this
 * invitation) stands in for it. The endpoint answers 401 without that session, 404 for a link
 * nobody holds, and 410 when the participant's part has ended (completed or declined), so the
 * old link no longer lets anyone edit. The token comes in the response body only, never in an
 * address, and the response is not cached.
 */
import { error, json } from '@sveltejs/kit';
import { PARTICIPANT_COOKIE } from '../../../../../lib/server/participant-session.ts';
import { issueParticipantToken } from '../../../../../lib/server/send-for-completion.ts';
import { NO_STORE } from '../../../../../lib/server/request.ts';
import { ServiceError } from '../../../../../lib/server/service.ts';
import { participantSessions, workflowDeps } from '../../../../../lib/server/workflow-runtime.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, cookies }) => {
  const d = await workflowDeps();
  const found = d.store.byInvitation(params.invitation);
  if (found === null) error(404, 'This link is no longer valid.');
  const session = participantSessions.check(cookies.get(PARTICIPANT_COOKIE), params.invitation);
  if (session === null || session.participant !== found.participant.id)
    error(401, 'Enter the passcode again.');
  if (found.participant.finished !== undefined) error(410, 'Your part of this document has ended.');
  try {
    // `auth_time` is when the passcode was accepted: a renewal does not claim a new sign-in.
    const issued = await issueParticipantToken(
      d,
      found.record,
      found.participant,
      session.authTime,
    );
    return json(issued, { headers: NO_STORE });
  } catch (e) {
    // The service's answer names a code, never the token (BE-088).
    if (e instanceof ServiceError) error(502, `The document service refused: ${e.code}.`);
    throw e;
  }
};
