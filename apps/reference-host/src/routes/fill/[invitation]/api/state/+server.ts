/**
 * Whether the participant's part has ended (UX-106), as the service reported it by webhook. The
 * page asks while the editor is open, so that it shows the confirmation also when the part was
 * finished from the editor's own guided bar, and no longer lets the person edit when it ended
 * elsewhere. Checked with the same session as the token endpoint; it names no one else.
 */
import { error, json } from '@sveltejs/kit';
import { PARTICIPANT_COOKIE } from '../../../../../lib/server/participant-session.ts';
import { NO_STORE } from '../../../../../lib/server/request.ts';
import { participantSessions, workflowDeps } from '../../../../../lib/server/workflow-runtime.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, cookies }) => {
  const d = await workflowDeps();
  const found = d.store.byInvitation(params.invitation);
  const session = participantSessions.check(cookies.get(PARTICIPANT_COOKIE), params.invitation);
  if (found === null || session === null || session.participant !== found.participant.id)
    error(401, 'Enter the passcode again.');
  return json({ finished: found.participant.finished ?? null }, { headers: NO_STORE });
};
