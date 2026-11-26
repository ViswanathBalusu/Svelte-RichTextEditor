/**
 * `GET /documents/{id}/suggestions/{sid}/introduction` (operation getSuggestionIntroduction; 08
 * §14; HIS-042 criteria 2 and 4): the commit that introduced a suggestion.
 *
 * A suggestion mark carries no time (03 §5), so its date is the server time of the commit that
 * introduced it, found by the suggestion's identifier. The identifier is looked up in an index that
 * the log store writes as each commit is stored (`LogStore.introducedBy`; table
 * `suggestion_introductions`), never by reading the log, and only the introducing commit's metadata
 * row is read for its time, user and origin.
 *
 * Row 2 of 07 §12 applies: `view` and the history gate. The date of a suggestion that is in the
 * document the caller reads is part of what they read, so it is answered whatever the gate; an
 * identifier that is no longer in the document is answered only when the introducing commit is at
 * or above the gate. The `seq` is given only when it is at or above the gate.
 */
import type { JsonNode } from '@docedit/model';
import { formatTimestamp } from '@docedit/model';
import { historyViewOf } from './history-reads.ts';
import { json, type Kit } from './kit.ts';
import { guard, type Handler } from './pipeline.ts';
import { ApiError } from './problems.ts';

const SUGGESTION_MARKS = new Set(['ins', 'del', 'fmt']);

/** Whether a suggestion mark with this identifier is in the document. */
function markedIn(doc: JsonNode, id: string): boolean {
  const marks = (n: JsonNode): boolean =>
    (n.marks ?? []).some(
      (m) => SUGGESTION_MARKS.has(m.type) && (m.attrs as { id?: unknown } | undefined)?.id === id,
    );
  const walk = (n: JsonNode): boolean => marks(n) || (n.content ?? []).some(walk);
  return walk(doc);
}

export function suggestionRoutes(k: Kit): Record<string, Handler> {
  const { d } = k;

  const getSuggestionIntroduction: Handler = async (ctx) => {
    const doc = ctx.params['id']!;
    guard(ctx.caller, 'read.history', doc);
    const sid = ctx.params['sid']!;
    const view = await historyViewOf(k, ctx, doc);
    const { ref, gate } = view;
    if (!d.logs.introducedBy)
      throw new ApiError('not_found', 'this server keeps no suggestion index');
    const seq = await d.logs.introducedBy(ref, sid);
    if (seq === undefined) throw new ApiError('not_found', 'no commit introduced this suggestion');
    const visible = seq >= gate.min;
    if (!visible && !markedIn(view.headDoc, sid))
      throw new ApiError(
        'forbidden',
        'the commit that introduced this suggestion is below your visibility gate (07 §8)',
      );
    // Metadata only: a commit whose payload was removed (HIS-040, HIS-032) still has its row.
    const rows = d.logs.readMeta
      ? await d.logs.readMeta(ref, seq, seq)
      : await d.logs.read(ref, seq, seq);
    const c = rows[0];
    if (!c) throw new ApiError('not_found', 'the introducing commit is not in the log');
    const name = await k.subsOf(ctx.caller.tenant, [c.user]);
    // The model of an assistant commit (UX-046 criterion 6): its identifier, and its registered
    // name while the registry still has it. The history keeps `agent` after an agent is disabled.
    const agent =
      c.agent !== undefined ? await d.tokens.agents.get(ctx.caller.tenant, c.agent) : undefined;
    return json(
      200,
      {
        suggestion: sid,
        time: formatTimestamp(c.time),
        user: name(c.user),
        origin: c.origin,
        ...(c.agent !== undefined ? { agent: c.agent } : {}),
        ...(agent !== undefined ? { agentName: agent.name } : {}),
        ...(visible ? { seq } : {}),
      },
      { 'Cache-Control': 'private, no-cache' },
    );
  };

  return { getSuggestionIntroduction };
}
