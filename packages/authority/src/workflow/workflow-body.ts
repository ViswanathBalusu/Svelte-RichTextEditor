/**
 * The body of `PUT /documents/{id}/workflow` (12 §6.1, §10; FRW-025). Pure: `checkWorkflowBody` says
 * whether a body may be stored and what is stored. The decisions taken where 12 is silent are in
 * docs/adr/0371-w4-FRW-025-workflow-put.md (proposed).
 *
 * - The members the server owns (`id`, `doc`, `state`, `rev`, `sentSeq`, `sentHash`, and a
 *   participant's `state` and `completedSeq`) may be echoed from a read; they are ignored. `doc`,
 *   when given, must be the document of the path.
 * - Every other member is checked and stored. An unknown member is refused.
 * - The routing conditions are checked against the document's fields and roles when the workflow
 *   is sent (FRW-037), not here; this check holds the shape of a route.
 */
import { isTimeZone } from '@docedit/rules';
import { checkParticipants, type ParticipantDraft } from './resource.ts';

/** The members of the resource that a writer sets besides the participants (12 §6.1). */
export interface WorkflowMembers {
  readonly routing?: readonly unknown[];
  readonly deadline?: string;
  readonly reminders?: { readonly firstAfterDays?: number; readonly everyDays?: number };
  readonly consent?: { readonly textId?: string; readonly version?: number };
  readonly finalisation?: { readonly seal?: string; readonly certificate?: boolean };
}

/** What a `PUT` stores: the time zone, the checked participants and the other writable members. */
export interface WorkflowInput {
  readonly timeZone: string;
  readonly participants: readonly ParticipantDraft[];
  readonly members: WorkflowMembers;
}

/** One refusal of a body: a JSON Pointer and the rule it breaks. Never the offending value. */
export interface WorkflowBodyProblem {
  readonly path: string;
  readonly rule: string;
}

export type WorkflowBodyCheck =
  | { readonly ok: true; readonly input: WorkflowInput }
  | { readonly ok: false; readonly problems: WorkflowBodyProblem[] };

/** Members the server owns: a writer may echo them from a read, and they are ignored. */
export const SERVER_OWNED_MEMBERS: readonly string[] = [
  'id',
  'doc',
  'state',
  'rev',
  'sentSeq',
  'sentHash',
];
const SERVER_OWNED_PARTICIPANT_MEMBERS: readonly string[] = ['state', 'completedSeq'];
const WRITABLE_MEMBERS: readonly string[] = [
  'timeZone',
  'participants',
  'routing',
  'deadline',
  'reminders',
  'consent',
  'finalisation',
];

/** The time zone of a workflow whose writer gives none (proposed, ADR 0371). */
export const DEFAULT_TIME_ZONE = 'UTC';
/** At most this many routes: the limit of rules in a document (invariant I15). */
const MAX_ROUTES = 500;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown): boolean => typeof v === 'string' && v.length > 0;
const isCount = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

/** Checks an object whose members are all optional; reports unknown and invalid members. */
function checkObject(
  value: unknown,
  at: string,
  checks: Record<string, (v: unknown) => boolean>,
  problems: WorkflowBodyProblem[],
): Obj | null {
  if (!isObj(value)) {
    problems.push({ path: at, rule: 'not_an_object' });
    return null;
  }
  let ok = true;
  for (const [key, v] of Object.entries(value)) {
    const check = checks[key];
    if (check === undefined) {
      problems.push({ path: `${at}/${key}`, rule: 'unknown_member' });
      ok = false;
    } else if (!check(v)) {
      problems.push({ path: `${at}/${key}`, rule: 'invalid_value' });
      ok = false;
    }
  }
  return ok ? value : null;
}

export function checkWorkflowBody(body: unknown, doc: string): WorkflowBodyCheck {
  const problems: WorkflowBodyProblem[] = [];
  if (!isObj(body)) return { ok: false, problems: [{ path: '', rule: 'not_an_object' }] };
  for (const key of Object.keys(body))
    if (!SERVER_OWNED_MEMBERS.includes(key) && !WRITABLE_MEMBERS.includes(key))
      problems.push({ path: `/${key}`, rule: 'unknown_member' });
  if (body['doc'] !== undefined && body['doc'] !== doc)
    problems.push({ path: '/doc', rule: 'not_the_document_of_the_path' });

  let timeZone = DEFAULT_TIME_ZONE;
  const tz = body['timeZone'];
  if (tz !== undefined) {
    if (typeof tz !== 'string' || !isTimeZone(tz))
      problems.push({ path: '/timeZone', rule: 'invalid_time_zone' });
    else timeZone = tz;
  }

  let participants: ParticipantDraft[] = [];
  const list = body['participants'];
  if (list === undefined) problems.push({ path: '/participants', rule: 'missing_member' });
  else {
    const stripped = Array.isArray(list)
      ? list.map((p: unknown) => {
          if (!isObj(p)) return p;
          return Object.fromEntries(
            Object.entries(p).filter(([key]) => !SERVER_OWNED_PARTICIPANT_MEMBERS.includes(key)),
          );
        })
      : list;
    const checked = checkParticipants(stripped);
    if (checked.ok) participants = checked.participants;
    else
      for (const q of checked.problems)
        problems.push({
          path:
            q.index < 0
              ? '/participants'
              : `/participants/${q.index}${q.member === null ? '' : `/${q.member}`}`,
          rule: q.reason,
        });
  }

  const members: { -readonly [K in keyof WorkflowMembers]: WorkflowMembers[K] } = {};

  const routing = body['routing'];
  if (routing !== undefined) {
    if (!Array.isArray(routing) || routing.length > MAX_ROUTES)
      problems.push({ path: '/routing', rule: 'invalid_value' });
    else {
      const before = problems.length;
      routing.forEach((route: unknown, i: number) => {
        if (
          !isObj(route) ||
          Object.keys(route).some((k) => k !== 'when' && k !== 'then') ||
          route['when'] === undefined ||
          !Array.isArray(route['then'])
        )
          problems.push({ path: `/routing/${i}`, rule: 'not_a_route' });
      });
      if (problems.length === before) members.routing = routing as unknown[];
    }
  }

  const deadline = body['deadline'];
  if (deadline !== undefined) {
    if (
      typeof deadline !== 'string' ||
      !INSTANT.test(deadline) ||
      Number.isNaN(Date.parse(deadline))
    )
      problems.push({ path: '/deadline', rule: 'invalid_instant' });
    else members.deadline = deadline;
  }

  if (body['reminders'] !== undefined) {
    const r = checkObject(
      body['reminders'],
      '/reminders',
      { firstAfterDays: isCount, everyDays: isCount },
      problems,
    );
    if (r !== null) members.reminders = r;
  }
  if (body['consent'] !== undefined) {
    const c = checkObject(
      body['consent'],
      '/consent',
      { textId: isText, version: isCount },
      problems,
    );
    if (c !== null) members.consent = c;
  }
  if (body['finalisation'] !== undefined) {
    const f = checkObject(
      body['finalisation'],
      '/finalisation',
      { seal: isText, certificate: (v) => typeof v === 'boolean' },
      problems,
    );
    if (f !== null) members.finalisation = f;
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, input: { timeZone, participants, members } };
}
