/**
 * The participant list of the workflow resource, as a host or an owner writes it (12 §6.1, §7, §10;
 * FRW-025 criterion 4, FRW-026 criteria 1 and 4). Pure: `checkParticipants` says whether a list may
 * be stored, and what it stores. The endpoint, the ETag and the second workflow check are the
 * workflow service's; `checkWorkflowBody` (workflow-body.ts) checks the whole body of a `PUT`.
 *
 * Decisions taken where 12 is silent are recorded in docs/adr/0248-lane-FRW-014-026.md (proposed):
 * - `order` is a safe integer of at least 1 (12 §6.1 gives equal and ascending values but no type);
 * - `roles` is a non-empty list of distinct, non-empty identifiers (FRW-026 criterion 1, "one or more
 *   roles");
 * - a participant holds only the members listed in `MEMBERS`. A contact detail (an e-mail address or a
 *   telephone number, FRW-026 criterion 4) is therefore an unknown member and is refused. `sub` and
 *   `name` are the only identifying members (12 §6.1).
 * - `completed` is not accepted from the writer: completion is the workflow's own transition.
 */
import { checkAuthRequire } from './access-code.ts';
import type { ParticipantKind } from './lifecycle.ts';

/** The participant kinds of 12 §6.1. Any other kind is refused. */
export const PARTICIPANT_KINDS: readonly ParticipantKind[] = ['filler', 'signer', 'approver', 'cc'];

/** The members a writer may give a participant. */
export const PARTICIPANT_MEMBERS: readonly string[] = [
  'id',
  'roles',
  'kind',
  'order',
  'sub',
  'name',
  'auth',
];

const KIND_SET: ReadonlySet<string> = new Set(PARTICIPANT_KINDS);
const MEMBER_SET: ReadonlySet<string> = new Set(PARTICIPANT_MEMBERS);

export type ParticipantProblemReason =
  | 'not_a_list'
  | 'not_an_object'
  | 'unknown_member'
  | 'missing_member'
  | 'invalid_id'
  | 'duplicate_id'
  | 'invalid_roles'
  | 'invalid_kind'
  | 'invalid_order'
  | 'invalid_sub'
  | 'invalid_name'
  | 'invalid_auth';

/** One refusal: the position of the participant in the list (-1 for the list itself) and the member. */
export interface ParticipantProblem {
  readonly index: number;
  readonly member: string | null;
  readonly reason: ParticipantProblemReason;
}

/** A participant as the writer gave it, checked. `completed` is not part of it (see the module note). */
export interface ParticipantDraft {
  readonly id: string;
  readonly roles: readonly string[];
  readonly kind: ParticipantKind;
  readonly order: number;
  readonly sub?: string;
  readonly name?: string;
  /** The authentication a participant must pass: the methods named in `require` (12 §6.1, §7). */
  readonly auth?: { readonly require?: readonly string[] };
}

export type ParticipantCheck =
  | { readonly ok: true; readonly participants: ParticipantDraft[] }
  | { readonly ok: false; readonly problems: ParticipantProblem[] };

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Whether a kind is one of the four kinds of 12 §6.1. */
export function isParticipantKind(value: unknown): value is ParticipantKind {
  return typeof value === 'string' && KIND_SET.has(value);
}

/** Checks one participant and returns its problems, or the draft it stands for. */
function checkOne(
  raw: unknown,
  index: number,
  seenIds: Set<string>,
): { problems: ParticipantProblem[]; draft: ParticipantDraft | null } {
  const problems: ParticipantProblem[] = [];
  const fail = (member: string | null, reason: ParticipantProblemReason): void => {
    problems.push({ index, member, reason });
  };
  if (!isObj(raw)) {
    fail(null, 'not_an_object');
    return { problems, draft: null };
  }
  for (const key of Object.keys(raw)) if (!MEMBER_SET.has(key)) fail(key, 'unknown_member');

  const id = raw['id'];
  if (id === undefined) fail('id', 'missing_member');
  else if (!isNonEmptyString(id)) fail('id', 'invalid_id');
  else if (seenIds.has(id)) fail('id', 'duplicate_id');
  else seenIds.add(id);

  const roles = raw['roles'];
  let rolesOk = false;
  if (roles === undefined) fail('roles', 'missing_member');
  else if (
    !Array.isArray(roles) ||
    roles.length === 0 ||
    !roles.every(isNonEmptyString) ||
    new Set(roles).size !== roles.length
  )
    fail('roles', 'invalid_roles');
  else rolesOk = true;

  const kind = raw['kind'];
  if (kind === undefined) fail('kind', 'missing_member');
  else if (!isParticipantKind(kind)) fail('kind', 'invalid_kind');

  const order = raw['order'];
  if (order === undefined) fail('order', 'missing_member');
  else if (typeof order !== 'number' || !Number.isSafeInteger(order) || order < 1)
    fail('order', 'invalid_order');

  const sub = raw['sub'];
  if (sub !== undefined && !isNonEmptyString(sub)) fail('sub', 'invalid_sub');
  const name = raw['name'];
  if (name !== undefined && !isNonEmptyString(name)) fail('name', 'invalid_name');

  const auth = raw['auth'];
  let authOk: ParticipantDraft['auth'] | undefined;
  if (auth !== undefined) {
    const req = isObj(auth) ? auth['require'] : undefined;
    // The only method is the access code (12 §6.1, §7; FRW-039 criterion 5): any other is refused.
    if (
      !checkAuthRequire(auth).ok ||
      (req !== undefined && (!Array.isArray(req) || new Set(req).size !== req.length))
    )
      fail('auth', 'invalid_auth');
    else authOk = req === undefined ? {} : { require: [...(req as string[])] };
  }

  if (problems.length > 0 || !isNonEmptyString(id) || !rolesOk || !isParticipantKind(kind)) {
    return { problems, draft: null };
  }
  if (typeof order !== 'number') return { problems, draft: null };
  const draft: ParticipantDraft = {
    id,
    roles: [...(roles as string[])],
    kind,
    order,
    ...(typeof sub === 'string' ? { sub } : {}),
    ...(typeof name === 'string' ? { name } : {}),
    ...(authOk !== undefined ? { auth: authOk } : {}),
  };
  return { problems, draft };
}

/**
 * Checks a participant list as written. Every problem is reported, each with its position and member,
 * so a writer can fix them all at once. When the list has no problem, the drafts are returned in the
 * order given.
 */
export function checkParticipants(input: unknown): ParticipantCheck {
  if (!Array.isArray(input)) {
    return { ok: false, problems: [{ index: -1, member: null, reason: 'not_a_list' }] };
  }
  const problems: ParticipantProblem[] = [];
  const drafts: ParticipantDraft[] = [];
  const seenIds = new Set<string>();
  input.forEach((raw, index) => {
    const checked = checkOne(raw, index, seenIds);
    problems.push(...checked.problems);
    if (checked.draft !== null) drafts.push(checked.draft);
  });
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, participants: drafts };
}
