/**
 * The host's directory for a participant (05 §8.1 `resolveUsers`, `searchPrincipals`; UX-106). A
 * participant may learn the names of the people in the same workflow and nobody else: the host's
 * directory is not opened to a person who has no account. Search finds no one. Checked with the
 * same session as the token endpoint.
 */
import { error, json } from '@sveltejs/kit';
import { PARTICIPANT_COOKIE } from '../../../../../lib/server/participant-session.ts';
import { NO_STORE } from '../../../../../lib/server/request.ts';
import { participantSessions, workflowDeps } from '../../../../../lib/server/workflow-runtime.ts';
import type { RequestHandler } from './$types';

const MAX = 100;

export const POST: RequestHandler = async ({ params, cookies, request }) => {
  const d = await workflowDeps();
  const found = d.store.byInvitation(params.invitation);
  const session = participantSessions.check(cookies.get(PARTICIPANT_COOKIE), params.invitation);
  if (found === null || session === null || session.participant !== found.participant.id)
    error(401, 'Enter the passcode again.');
  const body = (await request.json().catch(() => null)) as {
    resolve?: unknown;
    search?: unknown;
  } | null;
  if (body?.search !== undefined) return json({ principals: [] }, { headers: NO_STORE });
  if (!Array.isArray(body?.resolve)) error(400, 'Send { resolve: [ids] } or { search: { text } }.');
  const ids = body.resolve.filter((x): x is string => typeof x === 'string').slice(0, MAX);
  const names = new Map(found.record.participants.map((p) => [p.sub, p.name]));
  return json(
    {
      users: ids.map((id) => {
        const name = names.get(id);
        return name === undefined ? null : { id, name };
      }),
    },
    { headers: NO_STORE },
  );
};
